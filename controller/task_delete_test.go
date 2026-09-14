package controller

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func insertTask(t *testing.T, userId int, taskId string, status model.TaskStatus) *model.Task {
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
	require.NoError(t, task.InsertWithContext(context.Background()))
	return task
}

func taskExists(t *testing.T, userId int, taskId string) bool {
	t.Helper()
	_, exists, err := model.GetByTaskId(userId, taskId)
	require.NoError(t, err)
	return exists
}

// A finished record is only history, so the owner may clear it. A running one
// still has an upstream job to collect — deleting it would hide both the result
// and the reason the user was charged, so it is refused.
func TestDeleteTaskForUserRules(t *testing.T) {
	setupWorkbenchTestDB(t)

	insertTask(t, 1, "finished-mine", model.TaskStatusSuccess)
	insertTask(t, 1, "failed-mine", model.TaskStatusFailure)
	insertTask(t, 1, "running-mine", model.TaskStatusInProgress)
	insertTask(t, 2, "finished-somebody-else", model.TaskStatusSuccess)

	t.Run("a finished task of the caller is removed", func(t *testing.T) {
		require.NoError(t, model.DeleteTaskForUser(1, "finished-mine"))
		assert.False(t, taskExists(t, 1, "finished-mine"))
	})

	t.Run("a failed task is removable too", func(t *testing.T) {
		require.NoError(t, model.DeleteTaskForUser(1, "failed-mine"))
		assert.False(t, taskExists(t, 1, "failed-mine"))
	})

	t.Run("a running task is refused and kept", func(t *testing.T) {
		err := model.DeleteTaskForUser(1, "running-mine")
		require.ErrorIs(t, err, model.ErrTaskNotDeletable)
		assert.True(t, taskExists(t, 1, "running-mine"))
	})

	// Reported as missing rather than forbidden, so the endpoint cannot be used
	// to probe for other users' task ids.
	t.Run("another user's task is reported as missing and kept", func(t *testing.T) {
		err := model.DeleteTaskForUser(1, "finished-somebody-else")
		require.ErrorIs(t, err, model.ErrTaskNotFound)
		assert.True(t, taskExists(t, 2, "finished-somebody-else"))
	})

	t.Run("an unknown id is reported as missing", func(t *testing.T) {
		require.ErrorIs(t, model.DeleteTaskForUser(1, "never-existed"), model.ErrTaskNotFound)
	})
}

// The handler must resolve the path parameter and answer with the envelope the
// console expects, not with a bare error status.
func TestDeleteUserTaskHandler(t *testing.T) {
	gin.SetMode(gin.TestMode)
	setupWorkbenchTestDB(t)
	insertTask(t, 7, "handler-owned", model.TaskStatusSuccess)
	insertTask(t, 7, "handler-running", model.TaskStatusQueued)

	router := gin.New()
	router.DELETE("/api/task/self/:task_id",
		func(c *gin.Context) { c.Set("id", 7) },
		DeleteUserTask,
	)

	delete := func(taskId string) (int, map[string]any) {
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, httptest.NewRequest(http.MethodDelete, "/api/task/self/"+taskId, nil))
		body := map[string]any{}
		require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
		return recorder.Code, body
	}

	status, body := delete("handler-owned")
	assert.Equal(t, http.StatusOK, status)
	assert.Equal(t, true, body["success"])
	assert.False(t, taskExists(t, 7, "handler-owned"))

	status, body = delete("handler-running")
	assert.Equal(t, http.StatusOK, status)
	assert.Equal(t, false, body["success"])
	assert.Contains(t, body["message"], "finished")
	assert.True(t, taskExists(t, 7, "handler-running"))

	status, body = delete("not-here")
	assert.Equal(t, http.StatusOK, status)
	assert.Equal(t, false, body["success"])
	assert.Contains(t, body["message"], "not found")
}
