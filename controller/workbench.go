package controller

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	// Register the image decoders the reference-image validation relies on.
	_ "image/jpeg"
	_ "image/png"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	jsplugin "github.com/QuantumNous/new-api/pkg/jsplugin"
	relaychannel "github.com/QuantumNous/new-api/relay/channel"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/relay/helper"
	relaydto "github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/relaykit/types"
	"github.com/QuantumNous/new-api/service"

	"github.com/gin-gonic/gin"
)

// referenceImageSniffBytes matches the prefix http.DetectContentType inspects.
const referenceImageSniffBytes = 512

// referenceImageMaxDimension bounds the decoded dimensions of a reference
// image. Validation fully decodes the upload to prove it is a complete image,
// so this cap keeps a decompression bomb from turning validation into a memory
// amplifier. It sits far above the resolutions the image models accept as
// input, so it never rejects a legitimate reference image.
const referenceImageMaxDimension = 8192

// referenceImageRules maps a model-name prefix to how many reference images an
// image edit may carry. Matching mirrors the frontend size rules exactly — a
// lowercase prefix test, with no vendor-prefix stripping — so both sides read a
// model name the same way and cannot disagree about a model.
//
// The gpt-image-2 family is matched as a whole, so a sibling such as
// "gpt-image-2.5-x" is covered the day it is registered instead of silently
// falling back to a different count.
var referenceImageRules = []struct {
	prefix string
	max    int
}{
	{prefix: "gpt-image-2", max: 4},
}

// referenceImageLimitForModel reports how many reference images an image edit may
// carry for one model, or 0 when no limit is configured for it.
//
// Zero means "no configured limit", not "none allowed". The relay has always
// forwarded however many parts a request carries, so inventing a default cap for
// unlisted models would reject requests that work today — a model is narrowed
// only once its limit is known. That limit is the single source of truth for
// both sides: the models endpoint publishes it and the upload validator enforces
// it, so the picker and the server cannot drift apart.
func referenceImageLimitForModel(modelName string) int {
	name := strings.ToLower(modelName)
	for _, rule := range referenceImageRules {
		if strings.HasPrefix(name, rule.prefix) {
			return rule.max
		}
	}
	return 0
}

// maxWorkbenchCaptureBytes bounds how much of the relay response the workbench
// keeps for the display-only task record. Image responses can be tens of
// megabytes (base64 payloads), so the capture stops instead of holding an
// unbounded body in memory; the response itself always streams through.
const maxWorkbenchCaptureBytes = 32 << 20

// bodyCapturingWriter records everything the relay writes so the workbench can
// persist a task record after the response has already been sent. It keeps the
// embedded gin.ResponseWriter, so Flush/Status/Size and the http.Flusher
// assertion used by streaming helpers still reach the real writer.
type bodyCapturingWriter struct {
	gin.ResponseWriter
	body       bytes.Buffer
	statusCode int
	truncated  bool
}

func (w *bodyCapturingWriter) Write(b []byte) (int, error) {
	if w.shouldCapture(len(b)) {
		w.body.Write(b)
	}
	return w.ResponseWriter.Write(b)
}

func (w *bodyCapturingWriter) WriteString(s string) (int, error) {
	if w.shouldCapture(len(s)) {
		w.body.WriteString(s)
	}
	return w.ResponseWriter.WriteString(s)
}

func (w *bodyCapturingWriter) WriteHeader(statusCode int) {
	w.statusCode = statusCode
	w.ResponseWriter.WriteHeader(statusCode)
}

// shouldCapture reports whether the next chunk still fits the capture budget.
// Once the budget is exceeded the rest of the response is only proxied.
func (w *bodyCapturingWriter) shouldCapture(size int) bool {
	if w.truncated {
		return false
	}
	if w.body.Len()+size > maxWorkbenchCaptureBytes {
		w.truncated = true
		return false
	}
	return true
}

// validateWorkbenchReferenceImage rejects a reference-image upload the upstream
// cannot use, whichever carrier the caller used. A declared MIME type is not
// trustworthy, so every payload is sniffed and then fully decoded: it must
// really be a complete PNG or JPEG, not a truncated body carrying a valid
// header. The JSON carrier is covered too, because the adaptor forwards a JSON
// body untouched and would otherwise bypass every check below.
//
// Only the workbench path is validated; the shared /v1 relay keeps its existing
// behaviour, and no file content is ever echoed back to the caller.
func validateWorkbenchReferenceImage(c *gin.Context) error {
	if !strings.HasPrefix(c.Request.URL.Path, "/pg/images/edits") {
		return nil
	}
	contentType := c.Request.Header.Get("Content-Type")
	switch {
	case strings.Contains(contentType, "multipart/form-data"):
		return validateWorkbenchMultipartReferenceImages(c)
	case strings.HasPrefix(contentType, "application/json"):
		return validateWorkbenchJSONReferenceImages(c)
	default:
		return nil
	}
}

// validateWorkbenchMultipartReferenceImages checks every part of a multipart
// image-edit form. The parts are resolved with
// relaychannel.ImagePartsFromMultipart so validation covers exactly the set the
// adaptor forwards — "image", "image[]" and the indexed "image[N]" forms — and
// every one of them, not just the first. The optional mask is checked as well
// because it travels upstream too.
func validateWorkbenchMultipartReferenceImages(c *gin.Context) error {
	form, err := common.ParseMultipartFormReusable(c)
	if err != nil {
		return fmt.Errorf("invalid multipart form: %w", err)
	}
	// Keep the parsed form so the downstream OpenAI adaptor reuses it instead of
	// parsing the body a third time.
	c.Request.MultipartForm = form

	images := relaychannel.ImagePartsFromMultipart(form)
	if len(images) == 0 {
		return errors.New("reference image is required")
	}
	// The form carries the model the picker was showing, so the count is checked
	// against the same limit that picker displayed.
	var modelName string
	if values := form.Value["model"]; len(values) > 0 {
		modelName = values[0]
	}
	if err := validateReferenceImageCount(modelName, len(images)); err != nil {
		return err
	}
	for index, header := range images {
		if err := validateWorkbenchImagePart(referenceImagePartLabel(index, len(images)), header); err != nil {
			return err
		}
	}
	if mask := relaychannel.MaskPartFromMultipart(form); mask != nil {
		return validateWorkbenchImagePart("mask", mask)
	}
	return nil
}

// validateReferenceImageCount rejects an image edit that carries more reference
// images than the model accepts. The limit comes from the same lookup the models
// endpoint publishes, so the panel and the server agree by construction, and a
// model with no configured limit is not narrowed at all.
//
// A request that reached validation without a model name is reported without one
// rather than interpolating an empty string, which would read as " accepts at
// most 4 reference images" and name nothing at all.
func validateReferenceImageCount(modelName string, count int) error {
	limit := referenceImageLimitForModel(modelName)
	if limit <= 0 || count <= limit {
		return nil
	}
	if strings.TrimSpace(modelName) == "" {
		return fmt.Errorf("at most %d reference images are accepted", limit)
	}
	return fmt.Errorf("%s accepts at most %d reference images", modelName, limit)
}

// workbenchImageEditPayload holds the fields of a JSON image-edit request that
// can carry image content.
type workbenchImageEditPayload struct {
	Model  string          `json:"model"`
	Image  json.RawMessage `json:"image"`
	Images json.RawMessage `json:"images"`
	Mask   json.RawMessage `json:"mask"`
}

// validateWorkbenchJSONReferenceImages checks the images of a JSON image-edit
// request.
//
// Only data URLs are judged. An http(s) URL, a file id or a channel-specific
// base64 blob is left to the channel — that is what the passthrough exists for —
// and a request with no image at all is not rejected here either, since the
// relay already requires a prompt and some channels resolve the image from
// another field.
func validateWorkbenchJSONReferenceImages(c *gin.Context) error {
	var payload workbenchImageEditPayload
	if err := common.UnmarshalBodyReusable(c, &payload); err != nil {
		// A malformed body is reported by the relay with its own message.
		return nil
	}

	// The JSON carrier carries content too, so it enforces the same count as the
	// multipart one; otherwise it would be a way around the limit.
	referenceCount := len(workbenchDataURLsIn(payload.Image)) + len(workbenchDataURLsIn(payload.Images))
	if err := validateReferenceImageCount(payload.Model, referenceCount); err != nil {
		return err
	}

	for _, candidate := range []struct {
		label string
		raw   json.RawMessage
	}{
		{"reference image", payload.Image},
		{"reference image", payload.Images},
		{"mask", payload.Mask},
	} {
		for _, dataURL := range workbenchDataURLsIn(candidate.raw) {
			decoded, err := workbenchDataURLBytes(dataURL)
			if err != nil {
				return fmt.Errorf("%s is not a valid data URL", candidate.label)
			}
			if err := validateWorkbenchImage(candidate.label, int64(len(decoded)), bytes.NewReader(decoded)); err != nil {
				return err
			}
		}
	}
	return nil
}

// workbenchDataURLsIn collects the data URLs inside a raw JSON value, covering
// the shapes the protocol uses: a bare string, or an array of strings. Any other
// shape is left untouched.
func workbenchDataURLsIn(raw json.RawMessage) []string {
	if len(raw) == 0 {
		return nil
	}
	var single string
	if err := json.Unmarshal(raw, &single); err == nil {
		return dataURLOnly(single)
	}
	var list []string
	if err := json.Unmarshal(raw, &list); err == nil {
		var found []string
		for _, item := range list {
			found = append(found, dataURLOnly(item)...)
		}
		return found
	}
	return nil
}

func dataURLOnly(value string) []string {
	trimmed := strings.TrimSpace(value)
	if strings.HasPrefix(trimmed, "data:") {
		return []string{trimmed}
	}
	return nil
}

// workbenchDataURLBytes decodes the payload of a data URL, base64 or
// percent-encoded the way a browser encodes it.
func workbenchDataURLBytes(dataURL string) ([]byte, error) {
	comma := strings.IndexByte(dataURL, ',')
	if comma < 0 || !strings.HasPrefix(dataURL, "data:") {
		return nil, errors.New("invalid data URL")
	}
	meta, payload := dataURL[len("data:"):comma], dataURL[comma+1:]
	if strings.HasSuffix(meta, ";base64") {
		decoded, err := base64.StdEncoding.DecodeString(payload)
		if err != nil {
			return nil, errors.New("invalid data URL")
		}
		return decoded, nil
	}
	decoded, err := url.PathUnescape(payload)
	if err != nil {
		return nil, errors.New("invalid data URL")
	}
	return []byte(decoded), nil
}

// referenceImagePartLabel names a part in error messages: a single upload reads
// "reference image", a multi-image upload reads "reference image 2" so the
// caller can tell which one was rejected.
func referenceImagePartLabel(index, total int) string {
	if total <= 1 {
		return "reference image"
	}
	return fmt.Sprintf("reference image %d", index+1)
}

// validateWorkbenchImagePart proves one uploaded part is a complete, decodable
// PNG or JPEG of a sane size.
func validateWorkbenchImagePart(label string, header *multipart.FileHeader) error {
	if header == nil {
		return fmt.Errorf("%s is empty", label)
	}
	file, err := header.Open()
	if err != nil {
		return fmt.Errorf("%s cannot be read", label)
	}
	defer file.Close()
	return validateWorkbenchImage(label, header.Size, file)
}

// validateWorkbenchImage proves an upload is a complete, decodable PNG or JPEG
// of a sane size. The reader has to be seekable because the checks escalate and
// each one restarts from the beginning.
func validateWorkbenchImage(label string, size int64, reader io.ReadSeeker) error {
	if size <= 0 {
		return fmt.Errorf("%s is empty", label)
	}

	// Cheap check first: a prefix sniff rejects a non-image payload and a
	// declared type that disagrees with the content, without decoding pixels.
	head := make([]byte, referenceImageSniffBytes)
	read, err := io.ReadFull(reader, head)
	if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
		return fmt.Errorf("%s cannot be read", label)
	}
	switch http.DetectContentType(head[:read]) {
	case "image/png", "image/jpeg":
	default:
		return fmt.Errorf("%s must be a PNG or JPEG file", label)
	}

	// A prefix sniff only proves that the leading bytes look like an image: a
	// file truncated right after its header still passes. Read the real format
	// and dimensions next, and reject an oversized canvas *before* decoding so a
	// decompression bomb cannot turn validation into a memory amplifier.
	if _, err := reader.Seek(0, io.SeekStart); err != nil {
		return fmt.Errorf("%s cannot be read", label)
	}
	config, format, err := image.DecodeConfig(reader)
	if err != nil {
		return fmt.Errorf("%s is not a valid PNG or JPEG file", label)
	}
	if format != "png" && format != "jpeg" {
		return fmt.Errorf("%s must be a PNG or JPEG file", label)
	}
	if config.Width <= 0 || config.Height <= 0 ||
		config.Width > referenceImageMaxDimension || config.Height > referenceImageMaxDimension {
		return fmt.Errorf("%s dimensions must not exceed %d x %d",
			label, referenceImageMaxDimension, referenceImageMaxDimension)
	}

	// Finally decode the whole payload to prove the data is complete, so a
	// broken file is rejected here rather than surfacing upstream as an opaque
	// failure.
	if _, err := reader.Seek(0, io.SeekStart); err != nil {
		return fmt.Errorf("%s cannot be read", label)
	}
	if _, _, err := image.Decode(reader); err != nil {
		return fmt.Errorf("%s is truncated or corrupted", label)
	}
	return nil
}

// WorkbenchImage relays a synchronous OpenAI image generation (or edit)
// through the normal billing path, then persists an immediately-terminal task
// record so the result shows up in the workbench task list. The task record is
// display-only: it never triggers reserve/settle, so no double billing occurs.
func WorkbenchImage(c *gin.Context) {
	if err := validateWorkbenchReferenceImage(c); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": gin.H{"message": err.Error(), "type": "new_api_error"},
		})
		return
	}

	userId := c.GetInt("id")
	capture := &bodyCapturingWriter{ResponseWriter: c.Writer}
	c.Writer = capture

	// Mirror controller.Playground: resolve the effective group (the
	// X-Workbench-Group header was already applied by middleware.WorkbenchGroup),
	// write the user context and switch to a synthetic token before relaying.
	userCache, err := model.GetUserCache(userId)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error": gin.H{"message": err.Error(), "type": "new_api_error"},
		})
		return
	}
	userCache.WriteContext(c)

	relayInfo, err := relaycommon.GenRelayInfo(c, types.RelayFormatOpenAIImage, nil, nil)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error": gin.H{"message": err.Error(), "type": "new_api_error"},
		})
		return
	}

	tempToken := &model.Token{
		UserId: userId,
		Name:   fmt.Sprintf("workbench-image-%s", relayInfo.UsingGroup),
		Group:  relayInfo.UsingGroup,
	}
	_ = middleware.SetupContextForToken(c, tempToken)

	action := constant.TaskActionText2Img
	if strings.HasPrefix(c.Request.URL.Path, "/pg/images/edits") {
		action = constant.TaskActionImg2Img
	}

	Relay(c, types.RelayFormatOpenAIImage)

	statusCode := capture.statusCode
	if statusCode == 0 {
		statusCode = http.StatusOK
	}

	task := buildWorkbenchImageTask(userId, relayInfo.UsingGroup, c.GetInt("channel_id"),
		collectWorkbenchImageFields(c), statusCode, capture.body.Bytes(), action)
	task.PrivateData.Execution = service.TaskExecutionSnapshotFromContext(c)

	if capture.truncated {
		common.SysLog("workbench image response exceeded the capture budget; task record omits the parsed images")
	}

	// The response has already been sent, so a client disconnect at this point
	// must not drop the task record: keep the request values but detach its
	// cancellation.
	if insertErr := task.InsertWithContext(context.WithoutCancel(c.Request.Context())); insertErr != nil {
		common.SysError("workbench image task insert error: " + insertErr.Error())
	}
}

// buildWorkbenchImageTask builds the display-only task record for a finished
// synchronous image generation. It contains no billing calls: quota is a
// recomputed display value, so nothing here can ever double-charge.
func buildWorkbenchImageTask(userId int, group string, channelId int, fields workbenchImageRequestFields, statusCode int, responseBody []byte, action string) *model.Task {
	now := time.Now().Unix()
	task := &model.Task{
		TaskID:     model.GenerateTaskID(),
		Platform:   constant.TaskPlatformImage,
		UserId:     userId,
		Group:      group,
		ChannelId:  channelId,
		Action:     action,
		SubmitTime: now,
		StartTime:  now,
		FinishTime: now,
		// The record is terminal on both branches, so the poller (which selects
		// on progress != "100%" plus a non-terminal status) can never pick it up
		// and settle it a second time.
		Progress: "100%",
		Properties: model.Properties{
			Input:           fields.prompt,
			OriginModelName: fields.modelName,
		},
	}

	if statusCode >= 200 && statusCode < 300 {
		images := parseImageResponse(responseBody)
		task.Status = model.TaskStatusSuccess
		// Display-only value for the task list. No reserve/settle ever ran for
		// this record, so Quota here is never read back as an amount owed.
		task.Quota = fields.quota
		if len(images) > 0 && images[0].Url != "" {
			task.PrivateData.ResultURL = images[0].Url
		}
		task.SetData(map[string]any{
			"images": images,
			"size":   fields.size,
			"n":      fields.n,
		})
	} else {
		task.Status = model.TaskStatusFailure
		task.FailReason = workbenchFailReason(responseBody)
		task.SetData(map[string]any{
			"size": fields.size,
			"n":    fields.n,
		})
	}
	return task
}

type workbenchImageRequestFields struct {
	prompt    string
	modelName string
	size      string
	n         uint
	quota     int
}

// collectWorkbenchImageFields re-reads the request from body storage to derive
// display metadata for the task record and recompute the display quota the
// same way the relay pre-consume path does. It never charges anything; a
// pricing failure is logged and yields quota 0.
func collectWorkbenchImageFields(c *gin.Context) workbenchImageRequestFields {
	fields := workbenchImageRequestFields{}
	request, err := helper.GetAndValidateRequest(c, types.RelayFormatOpenAIImage)
	if err != nil {
		return fields
	}
	imageRequest, ok := request.(*relaydto.ImageRequest)
	if !ok {
		return fields
	}
	fields.prompt = imageRequest.Prompt
	fields.modelName = imageRequest.Model
	fields.size = imageRequest.Size
	if imageRequest.N != nil {
		fields.n = *imageRequest.N
	}
	meta := imageRequest.GetTokenCountMeta()
	pricingInfo, err := relaycommon.GenRelayInfo(c, types.RelayFormatOpenAIImage, imageRequest, nil)
	if err != nil {
		return fields
	}
	tokens, err := service.EstimateRequestToken(c, meta, pricingInfo)
	if err != nil {
		return fields
	}
	pricingInfo.SetEstimatePromptTokens(tokens)
	priceData, err := helper.ModelPriceHelper(c, pricingInfo, tokens, meta)
	if err != nil {
		common.SysError(fmt.Sprintf("workbench image display quota error: %v", err))
		return fields
	}
	fields.quota = priceData.QuotaToPreConsume
	if fields.quota == 0 {
		fields.quota = priceData.Quota
	}
	return fields
}

func parseImageResponse(body []byte) []relaydto.ImageData {
	var response relaydto.ImageResponse
	if err := common.Unmarshal(body, &response); err != nil {
		return nil
	}
	return response.Data
}

func workbenchFailReason(body []byte) string {
	reason := string(body)
	if len(reason) > 500 {
		reason = reason[:500]
	}
	return reason
}

type workbenchEstimateRequest struct {
	Type       string   `json:"type"`
	Group      string   `json:"group"`
	Model      string   `json:"model"`
	N          *uint    `json:"n,omitempty"`
	Size       string   `json:"size,omitempty"`
	Quality    string   `json:"quality,omitempty"`
	Mode       string   `json:"mode,omitempty"`
	Duration   *float64 `json:"duration,omitempty"`
	Resolution string   `json:"resolution,omitempty"`
	Aspect     string   `json:"aspect,omitempty"`
	RefImages  *int     `json:"ref_images,omitempty"`
}

// WorkbenchEstimate computes a display-only price estimate without consuming
// quota. Image estimates include size/quality/count ratios; video estimates
// are the base per-call model price, before the channel adaptor's runtime
// OtherRatios, so the UI labels them explicitly as estimates.
func WorkbenchEstimate(c *gin.Context) {
	var req workbenchEstimateRequest
	if err := common.DecodeJson(c.Request.Body, &req); err != nil {
		common.ApiError(c, errors.New("invalid request body"))
		return
	}

	// A missing model cannot be priced, and the pricing layer would report it as
	// an unconfigured price for the empty string. Reject it here so the caller
	// learns what is actually wrong.
	if strings.TrimSpace(req.Model) == "" {
		common.ApiError(c, errors.New("model is required"))
		return
	}

	// Validate user-controlled multipliers before any user/pricing context is
	// built, so out-of-range values are rejected cheaply and consistently.
	var imageN uint
	switch req.Type {
	case "image":
		imageN = uint(1)
		if req.N != nil {
			imageN = *req.N
		}
		if imageN == 0 || imageN > relaydto.MaxImageN {
			common.ApiError(c, errors.New("n must be between 1 and "+strconv.Itoa(relaydto.MaxImageN)))
			return
		}
	case "video":
		if req.Duration != nil && (*req.Duration <= 0 || *req.Duration > relaycommon.MaxTaskDurationSeconds) {
			common.ApiError(c, errors.New("invalid duration"))
			return
		}
	default:
		common.ApiError(c, errors.New("type must be image or video"))
		return
	}

	userId := c.GetInt("id")
	userCache, err := model.GetUserCache(userId)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	userCache.WriteContext(c)

	group := userCache.Group
	if req.Group != "" {
		if req.Group != userCache.Group && !service.GroupInUserUsableGroups(userCache.Group, req.Group) {
			common.ApiError(c, errors.New("group access denied"))
			return
		}
		group = req.Group
	}
	common.SetContextKey(c, constant.ContextKeyUsingGroup, group)
	// RelayInfo takes OriginModelName from this context key, which the relay
	// routes receive from middleware.Distribute. The estimate route runs no
	// distributor, so without publishing the model here the name stays empty and
	// pricing looks up "": a model that is in fact priced gets rejected, and the
	// message names no model at all. Token estimation reads the same key to pick
	// a tokenizer, so it was falling back to a generic one as well.
	common.SetContextKey(c, constant.ContextKeyOriginalModel, req.Model)

	tempToken := &model.Token{
		UserId: userId,
		Name:   fmt.Sprintf("workbench-estimate-%s", group),
		Group:  group,
	}
	_ = middleware.SetupContextForToken(c, tempToken)

	var quota int
	var freeModel bool
	// usePrice distinguishes an exact per-call price from a pre-consume estimate,
	// so the panel can label the number it shows honestly instead of calling a
	// known price an estimate.
	var usePrice bool
	switch req.Type {
	case "image":
		imageRequest := &relaydto.ImageRequest{
			Model:   req.Model,
			N:       common.GetPointer(imageN),
			Size:    req.Size,
			Quality: req.Quality,
		}
		meta := imageRequest.GetTokenCountMeta()
		relayInfo, genErr := relaycommon.GenRelayInfo(c, types.RelayFormatOpenAIImage, imageRequest, nil)
		if genErr != nil {
			common.ApiError(c, genErr)
			return
		}
		tokens, countErr := service.EstimateRequestToken(c, meta, relayInfo)
		if countErr != nil {
			common.ApiError(c, countErr)
			return
		}
		relayInfo.SetEstimatePromptTokens(tokens)
		priceData, priceErr := helper.ModelPriceHelper(c, relayInfo, tokens, meta)
		if priceErr != nil {
			common.ApiError(c, priceErr)
			return
		}
		quota = priceData.QuotaToPreConsume
		if quota == 0 {
			quota = priceData.Quota
		}
		freeModel = priceData.FreeModel
		usePrice = priceData.UsePrice
	case "video":
		relayInfo, genErr := relaycommon.GenRelayInfo(c, types.RelayFormatTask, nil, nil)
		if genErr != nil {
			common.ApiError(c, genErr)
			return
		}
		relayInfo.OriginModelName = req.Model
		priceData, priceErr := helper.ModelPriceHelperPerCall(c, relayInfo)
		if priceErr != nil {
			common.ApiError(c, priceErr)
			return
		}
		quota = priceData.Quota
		freeModel = priceData.FreeModel
		usePrice = priceData.UsePrice
	default:
		common.ApiError(c, errors.New("type must be image or video"))
		return
	}

	common.ApiSuccess(c, gin.H{
		"quota":      quota,
		"usd":        float64(quota) / common.QuotaPerUnit,
		"free_model": freeModel,
		"use_price":  usePrice,
		"estimate":   true,
	})
}

type workbenchModelItem struct {
	Name string `json:"name"`
	// Image is informational only. The image workbench no longer filters on it:
	// which models can generate images is decided by how the operator builds the
	// group, so every model the group exposes is offered. The flag is still
	// reported so a caller may badge or re-order known image models without
	// re-deriving the name patterns.
	Image    bool   `json:"image"`
	Video    bool   `json:"video"`
	Platform string `json:"platform,omitempty"`
	// MaxReferenceImages is how many reference images an image edit may carry for
	// this model, or 0 when no limit is configured. It is published so the panel
	// can enforce and display the same limit the upload validator enforces,
	// instead of keeping its own copy of the rule and drifting from the server.
	MaxReferenceImages int `json:"max_reference_images"`
}

// GetWorkbenchModels returns every model the caller's group exposes, annotated
// with best-effort image / video metadata.
//
// The image workbench offers the full list: capability by name pattern was
// fragile (a channel serving "gpt-image-2" was flagged as non-image because the
// pattern only knew "gpt-image-1"), and it hid real models with no error shown.
// The operator now decides by curating the group. The video panel still narrows
// on Video, which comes from the task-plugin registry rather than a name guess.
func GetWorkbenchModels(c *gin.Context) {
	user, err := model.GetUserCache(c.GetInt("id"))
	if err != nil {
		common.ApiError(c, err)
		return
	}
	groups := service.GetUserUsableGroups(user.Group)
	requested := c.Query("group")
	var groupsToQuery []string
	switch {
	case requested == "":
		for g := range groups {
			groupsToQuery = append(groupsToQuery, g)
		}
	case requested == "auto":
		groupsToQuery = service.GetUserAutoGroup(user.Group)
	default:
		if _, ok := groups[requested]; !ok {
			common.ApiError(c, errors.New("group access denied"))
			return
		}
		groupsToQuery = []string{requested}
	}
	videoPlatforms := workbenchVideoPlatforms()
	items := make([]workbenchModelItem, 0)
	for _, name := range service.GetGroupsEnabledModels(groupsToQuery) {
		items = append(items, workbenchModelItem{
			Name:               name,
			Image:              common.IsImageGenerationModel(name),
			Video:              videoPlatforms[name] != "",
			Platform:           videoPlatforms[name],
			MaxReferenceImages: referenceImageLimitForModel(name),
		})
	}
	common.ApiSuccess(c, items)
}

// workbenchVideoPlatforms maps model names declared by task plugins that
// implement the openai_video protocol to their plugin key.
func workbenchVideoPlatforms() map[string]string {
	result := make(map[string]string)
	for _, plugin := range jsplugin.DefaultRegistry.Generation().Plugins() {
		isVideo := false
		for _, protocol := range plugin.Meta.Protocols {
			if protocol.Name == "openai_video" {
				isVideo = true
				break
			}
		}
		if !isVideo {
			continue
		}
		for _, modelName := range plugin.Meta.Models {
			result[modelName] = plugin.Meta.Key
		}
	}
	return result
}
