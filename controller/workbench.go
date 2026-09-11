package controller

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	jsplugin "github.com/QuantumNous/new-api/pkg/jsplugin"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/relay/helper"
	relaydto "github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/relaykit/types"
	"github.com/QuantumNous/new-api/service"

	"github.com/gin-gonic/gin"
)

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

// WorkbenchImage relays a synchronous OpenAI image generation (or edit)
// through the normal billing path, then persists an immediately-terminal task
// record so the result shows up in the workbench task list. The task record is
// display-only: it never triggers reserve/settle, so no double billing occurs.
func WorkbenchImage(c *gin.Context) {
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

	tempToken := &model.Token{
		UserId: userId,
		Name:   fmt.Sprintf("workbench-estimate-%s", group),
		Group:  group,
	}
	_ = middleware.SetupContextForToken(c, tempToken)

	var quota int
	var freeModel bool
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
	default:
		common.ApiError(c, errors.New("type must be image or video"))
		return
	}

	common.ApiSuccess(c, gin.H{
		"quota":      quota,
		"usd":        float64(quota) / common.QuotaPerUnit,
		"free_model": freeModel,
		"estimate":   true,
	})
}

type workbenchModelItem struct {
	Name     string `json:"name"`
	Image    bool   `json:"image"`
	Video    bool   `json:"video"`
	Platform string `json:"platform,omitempty"`
}

// GetWorkbenchModels returns the user's enabled models annotated with image /
// video capabilities so the workbench can filter model dropdowns.
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
			Name:     name,
			Image:    common.IsImageGenerationModel(name),
			Video:    videoPlatforms[name] != "",
			Platform: videoPlatforms[name],
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
