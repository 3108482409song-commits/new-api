package controller

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"hash/crc32"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	relayconstant "github.com/QuantumNous/new-api/relay/constant"
	"github.com/QuantumNous/new-api/setting/ratio_setting"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func setupWorkbenchTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	previousDB, previousLogDB := model.DB, model.LOG_DB
	previousRedis := common.RedisEnabled
	previousMain, previousLogType := common.MainDatabaseType(), common.LogDatabaseType()
	db, _ := newAuditTestDatabase(t, "sqlite", "")
	model.DB, model.LOG_DB = db, db
	common.RedisEnabled = false
	common.SetDatabaseTypes(common.DatabaseTypeSQLite, common.DatabaseTypeSQLite)
	t.Cleanup(func() {
		model.DB, model.LOG_DB = previousDB, previousLogDB
		common.RedisEnabled = previousRedis
		common.SetDatabaseTypes(previousMain, previousLogType)
		sqlDB, err := db.DB()
		if err == nil {
			_ = sqlDB.Close()
		}
	})
	require.NoError(t, db.AutoMigrate(&model.Task{}))
	return db
}

func TestWorkbenchEstimateParameterValidation(t *testing.T) {
	gin.SetMode(gin.TestMode)
	cases := []struct {
		name string
		body string
	}{
		{"invalid type", `{"type":"foo","model":"x"}`},
		{"n zero", `{"type":"image","model":"x","n":0}`},
		{"n too large", `{"type":"image","model":"x","n":129}`},
		{"n wrapped negative passes bound to uint, still bounded", `{"type":"image","model":"x","n":18446744073686646784}`},
		{"duration too large", `{"type":"video","model":"kling-v1","duration":99999}`},
		{"duration negative", `{"type":"video","model":"kling-v1","duration":-1}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			ctx, _ := gin.CreateTestContext(recorder)
			ctx.Request = httptest.NewRequest(http.MethodPost, "/api/workbench/estimate", strings.NewReader(tc.body))
			ctx.Request.Header.Set("Content-Type", "application/json")
			WorkbenchEstimate(ctx)
			var response struct {
				Success bool `json:"success"`
			}
			require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &response))
			assert.False(t, response.Success)
		})
	}
}

// RelayInfo takes OriginModelName from a context key that only the Distribute
// middleware publishes, and the estimate route runs no distributor. The key used
// to stay unset, so pricing looked up the empty string and rejected a model that
// was configured, reporting "模型  的价格未配置" with no model in the message.
// Naming the requested model in the error is the observable proof the value now
// reaches the pricing layer.
func TestWorkbenchEstimatePricesTheRequestedModel(t *testing.T) {
	gin.SetMode(gin.TestMode)
	db := setupWorkbenchTestDB(t)
	require.NoError(t, db.AutoMigrate(&model.User{}))
	require.NoError(t, db.Create(&model.User{
		Id:       1,
		Username: "estimate-probe",
		Role:     common.RoleAdminUser,
		Status:   common.UserStatusEnabled,
		Group:    "default",
		Quota:    1 << 30,
	}).Error)

	// Deliberately unpriced: the estimate must fail, and the failure has to name
	// the model rather than an empty string.
	const modelName = "workbench-estimate-unpriced-model"
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Set("id", 1)
	ctx.Set(string(constant.ContextKeyUsingGroup), "default")
	ctx.Request = httptest.NewRequest(http.MethodPost, "/api/workbench/estimate",
		strings.NewReader(`{"type":"image","model":"`+modelName+`","n":1,"size":"1024x1024"}`))
	ctx.Request.Header.Set("Content-Type", "application/json")

	WorkbenchEstimate(ctx)

	body := recorder.Body.String()
	assert.Contains(t, body, modelName,
		"the pricing failure must name the requested model, got: %s", body)
	assert.NotContains(t, body, "模型  的价格未配置",
		"the model name must never reach pricing empty")
}

// A request without a model cannot be priced; saying so beats reporting an
// unconfigured price for the empty string.
func TestWorkbenchEstimateRequiresModel(t *testing.T) {
	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest(http.MethodPost, "/api/workbench/estimate",
		strings.NewReader(`{"type":"image","n":1,"size":"1024x1024"}`))
	ctx.Request.Header.Set("Content-Type", "application/json")

	WorkbenchEstimate(ctx)

	var response struct {
		Success bool   `json:"success"`
		Message string `json:"message"`
	}
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &response))
	assert.False(t, response.Success)
	assert.Contains(t, response.Message, "model is required")
}

// The panel labels the number it shows from use_price: a configured per-call
// price is an exact amount, whereas a ratio pre-consume is only a guess. Without
// the flag the console cannot tell them apart and has to call everything an
// estimate, which is what made a known price read as "estimated".
func TestWorkbenchEstimateReportsWhetherThePriceIsExact(t *testing.T) {
	gin.SetMode(gin.TestMode)
	db := setupWorkbenchTestDB(t)
	require.NoError(t, db.AutoMigrate(&model.User{}))
	require.NoError(t, db.Create(&model.User{
		Id:       2,
		Username: "estimate-priced",
		Role:     common.RoleAdminUser,
		Status:   common.UserStatusEnabled,
		Group:    "default",
		Quota:    1 << 30,
	}).Error)

	const modelName = "workbench-estimate-priced-model"
	savedPrices := ratio_setting.ModelPrice2JSONString()
	t.Cleanup(func() {
		require.NoError(t, ratio_setting.UpdateModelPriceByJSONString(savedPrices))
	})
	require.NoError(t, ratio_setting.UpdateModelPriceByJSONString(`{"`+modelName+`":1}`))

	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Set("id", 2)
	ctx.Set(string(constant.ContextKeyUsingGroup), "default")
	ctx.Request = httptest.NewRequest(http.MethodPost, "/api/workbench/estimate",
		strings.NewReader(`{"type":"image","model":"`+modelName+`","n":1,"size":"1024x1024"}`))
	ctx.Request.Header.Set("Content-Type", "application/json")

	WorkbenchEstimate(ctx)

	var response struct {
		Success bool `json:"success"`
		Data    struct {
			Quota    int  `json:"quota"`
			UsePrice bool `json:"use_price"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &response))
	require.True(t, response.Success, "estimate should succeed, got: %s", recorder.Body.String())
	assert.True(t, response.Data.UsePrice, "a configured price must be reported as exact")
	assert.Positive(t, response.Data.Quota)
}

func TestWorkbenchParseImageResponse(t *testing.T) {
	body := []byte(`{"created":1,"data":[{"url":"https://example.com/a.png","revised_prompt":"p"},{"b64_json":"data"}]}`)
	images := parseImageResponse(body)
	require.Len(t, images, 2)
	assert.Equal(t, "https://example.com/a.png", images[0].Url)
	assert.Equal(t, "data", images[1].B64Json)

	assert.Empty(t, parseImageResponse([]byte(`{"error":"boom"}`)))
}

func TestWorkbenchBuildImageTaskSuccessPersists(t *testing.T) {
	setupWorkbenchTestDB(t)
	userId := 42
	task := buildWorkbenchImageTask(
		userId, "default", 7,
		workbenchImageRequestFields{prompt: "a cat", modelName: "gpt-image-1", size: "1024x1024", n: 2, quota: 12345},
		http.StatusOK,
		[]byte(`{"created":1,"data":[{"url":"https://example.com/a.png"},{"url":"https://example.com/b.png"}]}`),
		constant.TaskActionText2Img,
	)
	require.NoError(t, task.InsertWithContext(context.Background()))
	require.NotEmpty(t, task.TaskID)
	assert.Equal(t, string(model.TaskStatusSuccess), string(task.Status))
	assert.Equal(t, "100%", task.Progress)
	assert.Equal(t, 12345, task.Quota)
	assert.Equal(t, "https://example.com/a.png", task.PrivateData.ResultURL)

	tasks := model.TaskGetAllUserTask(userId, 0, 10, model.SyncTaskQueryParams{Action: constant.TaskActionText2Img})
	require.Len(t, tasks, 1)
	assert.Equal(t, string(constant.TaskPlatformImage), string(tasks[0].Platform))
	assert.Equal(t, "a cat", tasks[0].Properties.Input)
	// Video actions must never match this record.
	assert.Empty(t, model.TaskGetAllUserTask(userId, 0, 10, model.SyncTaskQueryParams{Action: constant.TaskActionTextToVideo}))
}

func TestWorkbenchBuildImageTaskFailure(t *testing.T) {
	setupWorkbenchTestDB(t)
	task := buildWorkbenchImageTask(
		1, "default", 0,
		workbenchImageRequestFields{prompt: "boom", modelName: "gpt-image-1", n: 1},
		http.StatusBadRequest,
		[]byte(`{"error":{"message":"upstream failed"}}`),
		constant.TaskActionImg2Img,
	)
	require.NoError(t, task.InsertWithContext(context.Background()))
	assert.Equal(t, string(model.TaskStatusFailure), string(task.Status))
	assert.Contains(t, task.FailReason, "upstream failed")
	assert.Equal(t, constant.TaskActionImg2Img, task.Action)
	assert.Zero(t, task.Quota)
	// Terminal on failure too, so the task poller can never pick the record up.
	assert.Equal(t, "100%", task.Progress)
}

func TestWorkbenchBodyCapturingWriterBudget(t *testing.T) {
	// A chunk that exactly fills the budget is retained; anything larger is
	// dropped instead of being buffered.
	assert.True(t, (&bodyCapturingWriter{}).shouldCapture(maxWorkbenchCaptureBytes))
	oversized := &bodyCapturingWriter{}
	assert.False(t, oversized.shouldCapture(maxWorkbenchCaptureBytes+1))
	assert.True(t, oversized.truncated)
	assert.False(t, oversized.shouldCapture(0), "capture stays off once truncated")

	// The response is always proxied in full, even after capture stops.
	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	writer := &bodyCapturingWriter{ResponseWriter: ctx.Writer, truncated: true}
	_, err := writer.WriteString("streamed")
	require.NoError(t, err)
	assert.Empty(t, writer.body.String())
	assert.Equal(t, "streamed", recorder.Body.String())
}

func TestWorkbenchPath2RelayModeImages(t *testing.T) {
	assert.Equal(t, relayconstant.RelayModeImagesGenerations, relayconstant.Path2RelayMode("/pg/images/generations"))
	assert.Equal(t, relayconstant.RelayModeImagesEdits, relayconstant.Path2RelayMode("/pg/images/edits"))
}

// ── 参考图内容校验 ──────────────────────────────────────────────────────────
// 浏览器声明的 MIME 不可信，参考图必须按真实字节判断；只校验文件头也不够——
// 内容被截断的文件依然带着合法 PNG/JPEG 头，必须在提交前就被拒绝。

// testImageBytes encodes a real, complete image. A header-only fixture cannot
// exercise this validation: it is exactly what a truncated upload looks like.
// The texture keeps the compressed body several times larger than the headers so
// that truncating the payload lands in the pixel data, not in a marker segment.
func testImageBytes(t *testing.T, format string) []byte {
	t.Helper()
	const size = 64
	img := image.NewRGBA(image.Rect(0, 0, size, size))
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			img.Set(x, y, color.RGBA{
				R: uint8(x*7 + y),
				G: uint8(y*13 + x),
				B: uint8(x * y),
				A: 0xff,
			})
		}
	}

	var buffer bytes.Buffer
	switch format {
	case "png":
		require.NoError(t, png.Encode(&buffer, img))
	case "jpeg":
		require.NoError(t, jpeg.Encode(&buffer, img, nil))
	default:
		t.Fatalf("unsupported test image format %q", format)
	}
	return buffer.Bytes()
}

// truncateImage cuts the payload while leaving the recognisable file signature
// intact — precisely the case a header-only sniff cannot see.
func truncateImage(t *testing.T, data []byte) []byte {
	t.Helper()
	require.Greater(t, len(data), 3, "fixture must be long enough to truncate")
	return data[:len(data)*2/3]
}

// pngWithDeclaredSize rewrites the IHDR dimensions of a real PNG (and repairs the
// chunk checksum) so the decompression-bomb guard can be tested without ever
// allocating a genuinely enormous image.
func pngWithDeclaredSize(t *testing.T, data []byte, width, height uint32) []byte {
	t.Helper()
	require.Greater(t, len(data), 33, "fixture must contain a complete IHDR chunk")

	patched := append([]byte(nil), data...)
	binary.BigEndian.PutUint32(patched[16:20], width)
	binary.BigEndian.PutUint32(patched[20:24], height)

	checksum := crc32.NewIEEE()
	_, err := checksum.Write(patched[12:29]) // chunk type + 13 bytes of IHDR data
	require.NoError(t, err)
	binary.BigEndian.PutUint32(patched[29:33], checksum.Sum32())
	return patched
}

// workbenchUpload is one file part of an edits request.
type workbenchUpload struct {
	fieldName string
	fileName  string
	content   []byte
}

// workbenchMultipartUploadsForModel builds an edits request for a named model, so
// the per-model reference-image limit can be exercised.
func workbenchMultipartUploadsForModel(t *testing.T, modelName string, uploads []workbenchUpload) *gin.Context {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	require.NoError(t, writer.WriteField("model", modelName))
	require.NoError(t, writer.WriteField("prompt", "make it blue"))
	for _, upload := range uploads {
		part, err := writer.CreateFormFile(upload.fieldName, upload.fileName)
		require.NoError(t, err)
		_, err = part.Write(upload.content)
		require.NoError(t, err)
	}
	require.NoError(t, writer.Close())

	ctx, _ := gin.CreateTestContext(httptest.NewRecorder())
	ctx.Request = httptest.NewRequest(http.MethodPost, "/pg/images/edits", bytes.NewReader(body.Bytes()))
	ctx.Request.Header.Set("Content-Type", writer.FormDataContentType())
	t.Cleanup(func() { common.CleanupBodyStorage(ctx) })
	return ctx
}

// workbenchMultipartUploadsAt builds an edits request with arbitrary file parts
// so the multi-image and mask paths can be exercised. Repeated field names are
// allowed: the multipart reader preserves their order.
func workbenchMultipartUploadsAt(t *testing.T, path string, uploads []workbenchUpload) *gin.Context {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	require.NoError(t, writer.WriteField("model", "gpt-image-1"))
	require.NoError(t, writer.WriteField("prompt", "make it blue"))
	for _, upload := range uploads {
		part, err := writer.CreateFormFile(upload.fieldName, upload.fileName)
		require.NoError(t, err)
		_, err = part.Write(upload.content)
		require.NoError(t, err)
	}
	require.NoError(t, writer.Close())

	ctx, _ := gin.CreateTestContext(httptest.NewRecorder())
	ctx.Request = httptest.NewRequest(http.MethodPost, path, bytes.NewReader(body.Bytes()))
	ctx.Request.Header.Set("Content-Type", writer.FormDataContentType())
	t.Cleanup(func() { common.CleanupBodyStorage(ctx) })
	return ctx
}

func workbenchMultipartUploads(t *testing.T, uploads []workbenchUpload) *gin.Context {
	t.Helper()
	return workbenchMultipartUploadsAt(t, "/pg/images/edits", uploads)
}

func workbenchMultipartRequest(t *testing.T, path string, imageBytes []byte, imageName string) *gin.Context {
	t.Helper()
	var uploads []workbenchUpload
	if imageName != "" {
		uploads = append(uploads, workbenchUpload{"image", imageName, imageBytes})
	}
	return workbenchMultipartUploadsAt(t, path, uploads)
}

func TestValidateWorkbenchReferenceImageAcceptsCompleteImages(t *testing.T) {
	gin.SetMode(gin.TestMode)
	for _, testCase := range []struct {
		name      string
		imageName string
		image     []byte
	}{
		{"png", "reference.png", testImageBytes(t, "png")},
		{"jpeg", "reference.jpg", testImageBytes(t, "jpeg")},
		{"jpeg mislabelled by the extension still passes", "reference.png", testImageBytes(t, "jpeg")},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			ctx := workbenchMultipartRequest(t, "/pg/images/edits", testCase.image, testCase.imageName)
			assert.NoError(t, validateWorkbenchReferenceImage(ctx))
		})
	}
}

func TestValidateWorkbenchReferenceImageRejectsUnusableUploads(t *testing.T) {
	gin.SetMode(gin.TestMode)
	for _, testCase := range []struct {
		name      string
		imageName string
		image     []byte
		want      string
	}{
		{"renamed text file keeps a png name", "reference.png", []byte("plain text pretending to be a png"), "PNG or JPEG"},
		{"gif is not accepted", "reference.gif", []byte("GIF89a\x01\x00\x01\x00"), "PNG or JPEG"},
		{"missing image field", "", nil, "required"},
		{"empty file", "reference.png", []byte{}, "empty"},
		// A valid signature is not enough: the body has to be complete too.
		{"truncated png keeps a valid header", "reference.png", truncateImage(t, testImageBytes(t, "png")), "truncated or corrupted"},
		{"truncated jpeg keeps a valid header", "reference.jpg", truncateImage(t, testImageBytes(t, "jpeg")), "truncated or corrupted"},
		{"png skeleton without pixel data", "reference.png", []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00"), "not a valid PNG or JPEG"},
		{"declared dimensions beyond the accepted limit", "reference.png",
			pngWithDeclaredSize(t, testImageBytes(t, "png"), 20000, 20000), "dimensions must not exceed"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			ctx := workbenchMultipartRequest(t, "/pg/images/edits", testCase.image, testCase.imageName)
			err := validateWorkbenchReferenceImage(ctx)
			require.Error(t, err)
			assert.Contains(t, err.Error(), testCase.want)
		})
	}
}

// 适配器会把 image / image[] / image[N] 三种写法全部转发上游，且连 mask 一起。
// 校验必须覆盖同一集合、且逐个覆盖，否则合法请求会被误拒，而坏文件能被夹带通过。
func TestValidateWorkbenchReferenceImageCoversEveryForwardedPart(t *testing.T) {
	gin.SetMode(gin.TestMode)
	goodPNG := testImageBytes(t, "png")

	t.Run("array notation is accepted", func(t *testing.T) {
		ctx := workbenchMultipartUploads(t, []workbenchUpload{{"image[]", "a.png", goodPNG}})
		assert.NoError(t, validateWorkbenchReferenceImage(ctx))
	})

	t.Run("indexed notation is accepted", func(t *testing.T) {
		ctx := workbenchMultipartUploads(t, []workbenchUpload{
			{"image[0]", "a.png", goodPNG},
			{"image[1]", "b.png", goodPNG},
		})
		assert.NoError(t, validateWorkbenchReferenceImage(ctx))
	})

	t.Run("a corrupt second image is rejected", func(t *testing.T) {
		ctx := workbenchMultipartUploads(t, []workbenchUpload{
			{"image", "a.png", goodPNG},
			{"image", "b.png", truncateImage(t, goodPNG)},
		})
		err := validateWorkbenchReferenceImage(ctx)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "reference image 2")
		assert.Contains(t, err.Error(), "truncated or corrupted")
	})

	t.Run("a complete mask is accepted", func(t *testing.T) {
		ctx := workbenchMultipartUploads(t, []workbenchUpload{
			{"image", "a.png", goodPNG},
			{"mask", "m.png", goodPNG},
		})
		assert.NoError(t, validateWorkbenchReferenceImage(ctx))
	})

	t.Run("a truncated mask is rejected", func(t *testing.T) {
		ctx := workbenchMultipartUploads(t, []workbenchUpload{
			{"image", "a.png", goodPNG},
			{"mask", "m.png", truncateImage(t, goodPNG)},
		})
		err := validateWorkbenchReferenceImage(ctx)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "mask")
		assert.Contains(t, err.Error(), "truncated or corrupted")
	})

	t.Run("a non-image mask is rejected", func(t *testing.T) {
		ctx := workbenchMultipartUploads(t, []workbenchUpload{
			{"image", "a.png", goodPNG},
			{"mask", "m.png", []byte("not an image at all")},
		})
		err := validateWorkbenchReferenceImage(ctx)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "mask")
		assert.Contains(t, err.Error(), "PNG or JPEG")
	})

	t.Run("a mask alone does not satisfy the reference image", func(t *testing.T) {
		ctx := workbenchMultipartUploads(t, []workbenchUpload{{"mask", "m.png", goodPNG}})
		err := validateWorkbenchReferenceImage(ctx)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "required")
	})
}

// ── 参考图数量上限 ──────────────────────────────────────────────────────────
// 上限只有一处定义（`referenceImageRules`）：模型接口把它发布给前端，上传校验
// 用它拦截，两边不可能各持一份而分叉。

func TestReferenceImageLimitPerModel(t *testing.T) {
	for _, testCase := range []struct {
		model string
		want  int
	}{
		// 用户本次确认的四个模型，全部由 gpt-image-2 前缀族覆盖。
		{"gpt-image-2", 4},
		{"gpt-image-2.5", 4},
		{"gpt-image-2.5-flare", 4},
		{"gpt-image-2.5-sunburst", 4},
		// 未来登记的同族兄弟模型无需改代码即可获得同一上限。
		{"gpt-image-2.5-anything-new", 4},
		{"GPT-Image-2.5-Flare", 4},
		// 未登记的模型返回 0 = 不设限，而不是 1：给它们凭空加一个上限会拒掉
		// 今天能用的请求。
		{"gpt-image-1", 0},
		{"gpt-image-1.5", 0},
		{"dall-e-3", 0},
		{"seedream-3", 0},
		{"", 0},
	} {
		t.Run(testCase.model, func(t *testing.T) {
			assert.Equal(t, testCase.want, referenceImageLimitForModel(testCase.model))
		})
	}
}

func TestValidateWorkbenchReferenceImageEnforcesTheModelLimit(t *testing.T) {
	gin.SetMode(gin.TestMode)
	goodPNG := testImageBytes(t, "png")

	repeated := func(fieldName string, count int) []workbenchUpload {
		uploads := make([]workbenchUpload, 0, count)
		for i := range count {
			uploads = append(uploads, workbenchUpload{fieldName, fmt.Sprintf("%d.png", i), goodPNG})
		}
		return uploads
	}

	t.Run("the whole limit is accepted", func(t *testing.T) {
		ctx := workbenchMultipartUploadsForModel(t, "gpt-image-2", repeated("image", 4))
		assert.NoError(t, validateWorkbenchReferenceImage(ctx))
	})

	// array 写法与重复字段名都不能成为绕过上限的入口。
	t.Run("array notation is capped too", func(t *testing.T) {
		ctx := workbenchMultipartUploadsForModel(t, "gpt-image-2.5-flare", repeated("image[]", 5))
		err := validateWorkbenchReferenceImage(ctx)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "at most 4 reference images")
	})

	t.Run("one past the limit is rejected and names the model", func(t *testing.T) {
		ctx := workbenchMultipartUploadsForModel(t, "gpt-image-2.5-sunburst", repeated("image", 5))
		err := validateWorkbenchReferenceImage(ctx)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "gpt-image-2.5-sunburst")
		assert.Contains(t, err.Error(), "at most 4 reference images")
	})

	// mask 不是参考图，不占参考图额度；否则一张图加一个 mask 就会被误拒。
	t.Run("a mask does not consume the reference image budget", func(t *testing.T) {
		uploads := append(repeated("image", 4), workbenchUpload{"mask", "m.png", goodPNG})
		ctx := workbenchMultipartUploadsForModel(t, "gpt-image-2", uploads)
		assert.NoError(t, validateWorkbenchReferenceImage(ctx))
	})

	// 未登记的模型不受数量限制：中继一直原样转发，凭空设限会拒掉合法请求。
	t.Run("an unlisted model keeps forwarding every part", func(t *testing.T) {
		ctx := workbenchMultipartUploadsForModel(t, "gpt-image-1", repeated("image", 5))
		assert.NoError(t, validateWorkbenchReferenceImage(ctx))
	})

	// 数量检查先于内容检查，超限时给的是数量错误，而不是把第 5 张图当坏文件。
	t.Run("the count is reported before the part contents", func(t *testing.T) {
		uploads := append(repeated("image", 4), workbenchUpload{"image", "bad.png", []byte("not an image")})
		ctx := workbenchMultipartUploadsForModel(t, "gpt-image-2", uploads)
		err := validateWorkbenchReferenceImage(ctx)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "at most 4 reference images")
		assert.NotContains(t, err.Error(), "PNG or JPEG")
	})
}

func TestValidateWorkbenchJSONReferenceImageCountIsCapped(t *testing.T) {
	gin.SetMode(gin.TestMode)
	dataURL := base64DataURL("image/png", testImageBytes(t, "png"))

	payloadWith := func(modelName string, rawField string) string {
		return `{"model":"` + modelName + `","prompt":"x"` + rawField + `}`
	}

	t.Run("four images are accepted", func(t *testing.T) {
		ctx := workbenchJSONEditRequest(t, payloadWith("gpt-image-2",
			`,"images":["`+dataURL+`","`+dataURL+`","`+dataURL+`","`+dataURL+`"]`))
		assert.NoError(t, validateWorkbenchReferenceImage(ctx))
	})

	t.Run("five images are rejected", func(t *testing.T) {
		ctx := workbenchJSONEditRequest(t, payloadWith("gpt-image-2",
			`,"images":["`+dataURL+`","`+dataURL+`","`+dataURL+`","`+dataURL+`","`+dataURL+`"]`))
		err := validateWorkbenchReferenceImage(ctx)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "at most 4 reference images")
	})

	// image 与 images 同时出现时按总数计，否则拆开放就能绕过上限。
	t.Run("image and images count together", func(t *testing.T) {
		ctx := workbenchJSONEditRequest(t, payloadWith("gpt-image-2",
			`,"image":"`+dataURL+`","images":["`+dataURL+`","`+dataURL+`","`+dataURL+`","`+dataURL+`"]`))
		err := validateWorkbenchReferenceImage(ctx)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "at most 4 reference images")
	})

	t.Run("an unlisted model is not capped", func(t *testing.T) {
		ctx := workbenchJSONEditRequest(t, payloadWith("gpt-image-1",
			`,"images":["`+dataURL+`","`+dataURL+`","`+dataURL+`","`+dataURL+`","`+dataURL+`"]`))
		assert.NoError(t, validateWorkbenchReferenceImage(ctx))
	})
}

// ── JSON 载体的参考图校验 ────────────────────────────────────────────────────
// 适配器对 JSON 编辑请求原样透传（`if isJSONRequest(c) { return request, nil }`），
// 若不校验这条载体，multipart 上的签名与完整性检查就被整条绕过。

func workbenchJSONEditRequest(t *testing.T, payload string) *gin.Context {
	t.Helper()
	ctx, _ := gin.CreateTestContext(httptest.NewRecorder())
	ctx.Request = httptest.NewRequest(http.MethodPost, "/pg/images/edits", strings.NewReader(payload))
	ctx.Request.Header.Set("Content-Type", "application/json")
	t.Cleanup(func() { common.CleanupBodyStorage(ctx) })
	return ctx
}

func base64DataURL(mimeType string, data []byte) string {
	return "data:" + mimeType + ";base64," + base64.StdEncoding.EncodeToString(data)
}

func TestValidateWorkbenchJSONReferenceImages(t *testing.T) {
	gin.SetMode(gin.TestMode)
	truncatedPNG := truncateImage(t, testImageBytes(t, "png"))

	newRequest := func(t *testing.T, imageField string) *gin.Context {
		t.Helper()
		payload := `{"model":"gpt-image-1","prompt":"x"` + imageField + `}`
		return workbenchJSONEditRequest(t, payload)
	}

	t.Run("a complete data URL image is accepted", func(t *testing.T) {
		ctx := newRequest(t, `,"image":"`+base64DataURL("image/png", testImageBytes(t, "png"))+`"`)
		assert.NoError(t, validateWorkbenchReferenceImage(ctx))
	})

	t.Run("a percent-encoded data URL is accepted", func(t *testing.T) {
		ctx := newRequest(t, `,"image":"data:image/png,`+url.PathEscape(string(testImageBytes(t, "png")))+`"`)
		assert.NoError(t, validateWorkbenchReferenceImage(ctx))
	})

	t.Run("a truncated data URL image is rejected", func(t *testing.T) {
		ctx := newRequest(t, `,"image":"`+base64DataURL("image/png", truncatedPNG)+`"`)
		err := validateWorkbenchReferenceImage(ctx)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "truncated or corrupted")
	})

	t.Run("a truncated entry inside images is rejected", func(t *testing.T) {
		ctx := newRequest(t, `,"images":["`+base64DataURL("image/png", testImageBytes(t, "png"))+
			`","`+base64DataURL("image/png", truncatedPNG)+`"]`)
		err := validateWorkbenchReferenceImage(ctx)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "truncated or corrupted")
	})

	t.Run("a truncated mask is rejected", func(t *testing.T) {
		ctx := newRequest(t, `,"mask":"`+base64DataURL("image/png", truncatedPNG)+`"`)
		err := validateWorkbenchReferenceImage(ctx)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "mask")
	})

	t.Run("a malformed data URL is rejected", func(t *testing.T) {
		ctx := newRequest(t, `,"image":"data:image/png;base64,not-valid-base64!!"`)
		err := validateWorkbenchReferenceImage(ctx)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "not a valid data URL")
	})

	t.Run("a non-image data URL is rejected", func(t *testing.T) {
		ctx := newRequest(t, `,"image":"`+base64DataURL("text/plain", []byte("plain text"))+`"`)
		err := validateWorkbenchReferenceImage(ctx)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "PNG or JPEG")
	})

	// 非 data URL 的取值属于渠道私有约定（http 地址、文件 id、原始 base64），
	// 不能替渠道判死，必须原样放过。
	t.Run("an http image URL is left to the channel", func(t *testing.T) {
		ctx := newRequest(t, `,"image":"https://example.com/a.png"`)
		assert.NoError(t, validateWorkbenchReferenceImage(ctx))
	})

	t.Run("a request without an image is not rejected here", func(t *testing.T) {
		assert.NoError(t, validateWorkbenchReferenceImage(newRequest(t, "")))
	})
}

// 只有工作台参考图路径被校验，标准 /v1 与文生图路径保持既有行为。
func TestValidateWorkbenchReferenceImageSkipsOtherPaths(t *testing.T) {
	gin.SetMode(gin.TestMode)
	ctx := workbenchMultipartRequest(t, "/pg/images/generations", []byte("not an image"), "reference.png")
	assert.NoError(t, validateWorkbenchReferenceImage(ctx))
}

func TestWorkbenchGroupWithoutHeaderKeepsContext(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(middleware.WorkbenchGroup())
	router.GET("/probe", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{
			"using_group": common.GetContextKeyString(c, constant.ContextKeyUsingGroup),
		})
	})

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/probe", nil)
	router.ServeHTTP(recorder, request)
	var response struct {
		UsingGroup string `json:"using_group"`
	}
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &response))
	assert.Empty(t, response.UsingGroup)
}
