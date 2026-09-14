package controller

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// encodeTestPNG produces a real PNG payload, because the preview is built by
// decoding the stored bytes rather than by trusting the field.
func encodeTestPNG(t *testing.T, width, height int) string {
	t.Helper()
	source := image.NewRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			source.Set(x, y, color.RGBA{R: uint8(x), G: uint8(y), B: 128, A: 255})
		}
	}
	var encoded bytes.Buffer
	require.NoError(t, png.Encode(&encoded, source))
	return base64.StdEncoding.EncodeToString(encoded.Bytes())
}

func insertImageTask(t *testing.T, userId int, taskId string, status model.TaskStatus, data any) {
	t.Helper()
	task := &model.Task{
		TaskID:     taskId,
		Platform:   constant.TaskPlatformImage,
		UserId:     userId,
		Action:     constant.TaskActionText2Img,
		Status:     status,
		Progress:   "100%",
		SubmitTime: 1,
		StartTime:  1,
		FinishTime: 1,
	}
	if data != nil {
		task.SetData(data)
	}
	require.NoError(t, task.InsertWithContext(context.Background()))
}

func TestSplitCommaSeparated(t *testing.T) {
	// A blank value means "no filter", which the query builders have to be able
	// to tell apart from "a filter matching nothing".
	assert.Nil(t, splitCommaSeparated(""))
	assert.Nil(t, splitCommaSeparated("   "))
	assert.Nil(t, splitCommaSeparated(", ,"))

	assert.Equal(t, []string{"a"}, splitCommaSeparated("a"))
	assert.Equal(t, []string{"a", "b"}, splitCommaSeparated("a,b"))
	assert.Equal(t, []string{"a", "b"}, splitCommaSeparated(" a , b "))
	assert.Equal(t, []string{"a", "b"}, splitCommaSeparated("a,,b"))
}

// The list is paged on the server, so a filter has to select across the whole
// history instead of the rows that happen to be on the current page.
func TestTaskStatusesFilter(t *testing.T) {
	setupWorkbenchTestDB(t)

	insertTask(t, 5, "status-success", model.TaskStatusSuccess)
	insertTask(t, 5, "status-failure", model.TaskStatusFailure)
	insertTask(t, 5, "status-queued", model.TaskStatusQueued)
	insertTask(t, 6, "status-other-user", model.TaskStatusSuccess)

	running := model.SyncTaskQueryParams{Statuses: []string{
		string(model.TaskStatusNotStart),
		string(model.TaskStatusSubmitted),
		string(model.TaskStatusQueued),
		string(model.TaskStatusInProgress),
	}}
	items := model.TaskGetAllUserTask(5, 0, 10, running)
	require.Len(t, items, 1)
	assert.Equal(t, "status-queued", items[0].TaskID)
	// The count feeds the pager, so it has to agree with the rows returned.
	assert.Equal(t, int64(1), model.TaskCountAllUserTask(5, running))
	assert.Equal(t, int64(1), model.TaskCountAllTasks(running))

	// A single status keeps working on its own.
	single := model.SyncTaskQueryParams{Status: string(model.TaskStatusSuccess)}
	items = model.TaskGetAllUserTask(5, 0, 10, single)
	require.Len(t, items, 1)
	assert.Equal(t, "status-success", items[0].TaskID)

	// When both are present the set wins, so the handler cannot end up ANDing a
	// scalar status with a set of statuses into an always-empty filter.
	both := model.SyncTaskQueryParams{
		Status:   string(model.TaskStatusFailure),
		Statuses: []string{string(model.TaskStatusSuccess)},
	}
	items = model.TaskGetAllUserTask(5, 0, 10, both)
	require.Len(t, items, 1)
	assert.Equal(t, "status-success", items[0].TaskID)

	// Another user's records stay out of the result.
	assert.Empty(t, model.TaskGetAllUserTask(9, 0, 10, model.SyncTaskQueryParams{}))
}

// A result is stored as a multi-megabyte base64 payload, so the list ships a
// small preview instead and the payload stays reachable one record at a time.
func TestBuildTaskPreview(t *testing.T) {
	setupWorkbenchTestDB(t)

	imageTask := &model.Task{
		TaskID:   "preview-image",
		Platform: constant.TaskPlatformImage,
		Action:   constant.TaskActionText2Img,
		Status:   model.TaskStatusSuccess,
	}
	imageTask.SetData(map[string]any{
		"images": []map[string]any{{"b64_json": encodeTestPNG(t, 400, 300)}},
	})

	preview := buildTaskPreview(imageTask)
	require.True(t, strings.HasPrefix(preview, "data:image/jpeg;base64,"),
		"a stored payload should be shrunk into a data URL, got %q", preview)

	decoded, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(preview, "data:image/jpeg;base64,"))
	require.NoError(t, err)
	scaled, _, err := image.Decode(bytes.NewReader(decoded))
	require.NoError(t, err)
	assert.LessOrEqual(t, scaled.Bounds().Dx(), taskPreviewMaxSide)
	assert.LessOrEqual(t, scaled.Bounds().Dy(), taskPreviewMaxSide)

	// A result the provider already hosts is passed through: re-encoding bytes
	// the client can fetch directly would only add work.
	hosted := &model.Task{TaskID: "preview-hosted", Status: model.TaskStatusSuccess}
	hosted.SetData(map[string]any{
		"images": []map[string]any{{"url": "https://cdn.example/a.png"}},
	})
	assert.Equal(t, "https://cdn.example/a.png", buildTaskPreview(hosted))

	// Nothing to preview until the result exists.
	for _, status := range []model.TaskStatus{model.TaskStatusInProgress, model.TaskStatusQueued, model.TaskStatusFailure} {
		task := &model.Task{TaskID: "preview-" + string(status), Status: status}
		task.SetData(map[string]any{
			"images": []map[string]any{{"b64_json": encodeTestPNG(t, 64, 64)}},
		})
		assert.Empty(t, buildTaskPreview(task), "status %s has no settled result", status)
	}

	// An unreadable payload degrades to no thumbnail rather than to an error
	// that would hide the whole history.
	broken := &model.Task{TaskID: "preview-broken", Status: model.TaskStatusSuccess}
	broken.SetData(map[string]any{
		"images": []map[string]any{{"b64_json": "not-an-image"}},
	})
	assert.Empty(t, buildTaskPreview(broken))

	// A settled result never changes, so the derived preview is computed once.
	assert.Equal(t, preview, buildTaskPreview(imageTask))
	cached, ok := cachedTaskPreview("preview-image")
	assert.True(t, ok)
	assert.Equal(t, preview, cached)
}

func TestUserTaskListShipsPreviewInsteadOfPayload(t *testing.T) {
	gin.SetMode(gin.TestMode)
	setupWorkbenchTestDB(t)
	insertImageTask(t, 4, "listed-image", model.TaskStatusSuccess, map[string]any{
		"images": []map[string]any{{"b64_json": encodeTestPNG(t, 320, 320)}},
	})

	router := gin.New()
	router.GET("/api/task/self", func(c *gin.Context) { c.Set("id", 4) }, GetUserTask)

	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/task/self", nil))
	require.Equal(t, http.StatusOK, recorder.Code)

	body := map[string]any{}
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
	assert.Equal(t, true, body["success"])

	page := body["data"].(map[string]any)
	items := page["items"].([]any)
	require.Len(t, items, 1)
	row := items[0].(map[string]any)
	// Fifteen raw results would be tens of megabytes per page.
	assert.Nil(t, row["data"], "the list must not carry the raw result payload")
	preview, _ := row["preview"].(string)
	assert.True(t, strings.HasPrefix(preview, "data:image/jpeg;base64,"), "got %q", preview)
}

func TestGetUserTaskDetailHandler(t *testing.T) {
	gin.SetMode(gin.TestMode)
	setupWorkbenchTestDB(t)
	insertImageTask(t, 8, "detail-mine", model.TaskStatusSuccess, map[string]any{
		"images": []map[string]any{{"url": "https://cdn.example/detail.png"}},
	})
	insertImageTask(t, 9, "detail-somebody-else", model.TaskStatusSuccess, nil)

	router := gin.New()
	router.GET("/api/task/self/:task_id", func(c *gin.Context) { c.Set("id", 8) }, GetUserTaskDetail)

	get := func(taskId string) map[string]any {
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/task/self/"+taskId, nil))
		require.Equal(t, http.StatusOK, recorder.Code)
		body := map[string]any{}
		require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
		return body
	}

	body := get("detail-mine")
	require.Equal(t, true, body["success"])
	detail := body["data"].(map[string]any)
	assert.Equal(t, "detail-mine", detail["task_id"])
	// The viewer needs the full payload: that is what this endpoint exists for.
	assert.NotNil(t, detail["data"], "the detail view needs the full result payload")
	// A provider-hosted result is passed through, so the detail view can play or
	// download the original.
	assert.Equal(t, "https://cdn.example/detail.png", detail["preview"])

	// Another user's record is reported as missing, so ids cannot be probed.
	other := get("detail-somebody-else")
	assert.Equal(t, false, other["success"])
	assert.Contains(t, other["message"], "not found")

	missing := get("never-existed")
	assert.Equal(t, false, missing["success"])
	assert.Contains(t, missing["message"], "not found")
}
