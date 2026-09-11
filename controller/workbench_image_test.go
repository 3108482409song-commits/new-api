package controller

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	relayconstant "github.com/QuantumNous/new-api/relay/constant"
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
