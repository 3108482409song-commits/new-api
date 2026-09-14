package relay

import (
	"bytes"
	"errors"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/relay/channel"
	"github.com/QuantumNous/new-api/relay/channel/deepseek"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	relayconstant "github.com/QuantumNous/new-api/relay/constant"
	relaydto "github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/relaykit/types"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestIsUnimplementedAdaptorErrorUsesSentinel(t *testing.T) {
	assert.False(t, isUnimplementedAdaptorError(nil))
	assert.True(t, isUnimplementedAdaptorError(channel.ErrNotImplemented))
	assert.True(t, isUnimplementedAdaptorError(
		fmt.Errorf("conversion failed: %w", channel.ErrNotImplemented),
	))

	// Only the sentinel counts. The previous implementation matched the message
	// with strings.Contains, so any unrelated error that happened to mention the
	// phrase was reported to the user as "this channel does not support image
	// editing". These must no longer take that branch.
	assert.False(t, isUnimplementedAdaptorError(errors.New("not implemented")))
	assert.False(t, isUnimplementedAdaptorError(
		errors.New("upstream says: feature not implemented yet"),
	))
	assert.False(t, isUnimplementedAdaptorError(errors.New("image is required")))
}

// A generated stub must return the sentinel; otherwise ImageHelper cannot tell
// "this channel has no image editing" from a real conversion failure.
func TestDeepSeekStubReturnsNotImplementedSentinel(t *testing.T) {
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest(http.MethodPost, "/v1/images/edits", nil)
	c.Request.Header.Set("Content-Type", "application/json")

	_, err := (&deepseek.Adaptor{}).ConvertImageRequest(
		c, &relaycommon.RelayInfo{}, relaydto.ImageRequest{Model: "gpt-image-1"},
	)
	require.Error(t, err)
	assert.True(t, isUnimplementedAdaptorError(err), "适配器桩必须返回 channel.ErrNotImplemented")
}

func imageEditRelayInfo(t *testing.T, channelType int) (*gin.Context, *relaycommon.RelayInfo) {
	t.Helper()

	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	require.NoError(t, writer.WriteField("model", "gpt-image-1"))
	require.NoError(t, writer.WriteField("prompt", "make it blue"))
	fileWriter, err := writer.CreateFormFile("image", "reference.png")
	require.NoError(t, err)
	_, err = fileWriter.Write([]byte("\x89PNG\r\n\x1a\nreference-bytes"))
	require.NoError(t, err)
	require.NoError(t, writer.Close())

	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest(http.MethodPost, "/pg/images/edits", bytes.NewReader(body.Bytes()))
	c.Request.Header.Set("Content-Type", writer.FormDataContentType())
	common.SetContextKey(c, constant.ContextKeyChannelType, channelType)

	imageRequest := &relaydto.ImageRequest{Model: "gpt-image-1", Prompt: "make it blue"}
	info, err := relaycommon.GenRelayInfo(c, types.RelayFormatOpenAIImage, imageRequest, nil)
	require.NoError(t, err)
	info.RelayMode = relayconstant.RelayModeImagesEdits
	info.OriginModelName = "gpt-image-1"
	// ChannelMeta (and its UpstreamModelName) is built by ImageHelper's own
	// InitChannelMeta call, so it must be left nil here.

	t.Cleanup(func() { common.CleanupBodyStorage(c) })
	return c, info
}

// Direct regression test for ImageHelper: a channel whose adaptor only has the
// generated stub must surface an actionable message instead of the raw
// "not implemented" text, and it must still leave room for a retry on another
// channel (so the error is not marked as skip-retry).
func TestImageHelperReportsUnsupportedImageEditing(t *testing.T) {
	c, info := imageEditRelayInfo(t, constant.ChannelTypeDeepSeek)

	newAPIError := ImageHelper(c, info)

	require.NotNil(t, newAPIError)
	assert.Contains(t, newAPIError.Error(), "does not support image editing")
	assert.Equal(t, types.ErrorCodeConvertRequestFailed, newAPIError.GetErrorCode())
	assert.False(t, types.IsSkipRetryError(newAPIError), "换渠道仍可能成功，不应跳过重试")
}
