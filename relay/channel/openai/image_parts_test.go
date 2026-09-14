package openai

import (
	"bytes"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/QuantumNous/new-api/relay/channel"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	relayconstant "github.com/QuantumNous/new-api/relay/constant"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type adaptorUpload struct {
	fieldName string
	content   string
}

func imageEditContext(t *testing.T, uploads []adaptorUpload) *gin.Context {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	require.NoError(t, writer.WriteField("model", "gpt-image-1"))
	require.NoError(t, writer.WriteField("prompt", "edit this image"))
	for _, upload := range uploads {
		part, err := writer.CreateFormFile(upload.fieldName, upload.fieldName+".png")
		require.NoError(t, err)
		_, err = part.Write([]byte(upload.content))
		require.NoError(t, err)
	}
	require.NoError(t, writer.Close())

	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest(http.MethodPost, "/v1/images/edits", &body)
	c.Request.Header.Set("Content-Type", writer.FormDataContentType())
	return c
}

// convertEditsRequest runs the adaptor and replays what it produced, returning
// the re-parsed form. The adaptor publishes the rebuilt Content-Type (and with it
// the new boundary) on the request header, so the replay must use that value
// rather than the original one.
func convertEditsRequest(t *testing.T, c *gin.Context) (*multipart.Form, error) {
	t.Helper()
	converted, err := (&Adaptor{}).ConvertImageRequest(
		c,
		&relaycommon.RelayInfo{RelayMode: relayconstant.RelayModeImagesEdits},
		dto.ImageRequest{Model: "gpt-image-1", Prompt: "edit this image"},
	)
	if err != nil {
		return nil, err
	}
	body, ok := converted.(*bytes.Buffer)
	require.True(t, ok)

	replayed := httptest.NewRequest(http.MethodPost, "/v1/images/edits", bytes.NewReader(body.Bytes()))
	replayed.Header.Set("Content-Type", c.Request.Header.Get("Content-Type"))
	require.NoError(t, replayed.ParseMultipartForm(32<<20))
	return replayed.MultipartForm, nil
}

func partContent(t *testing.T, header *multipart.FileHeader) string {
	t.Helper()
	file, err := header.Open()
	require.NoError(t, err)
	defer file.Close()
	content, err := io.ReadAll(file)
	require.NoError(t, err)
	return string(content)
}

// Resolving the image parts through a shared helper only pays off if the adaptor
// really keeps forwarding every accepted field name: "image", "image[]" and the
// indexed "image[N]" forms, in order and with the payloads intact.
func TestConvertImageEditRequestCoversEveryAcceptedImageField(t *testing.T) {
	gin.SetMode(gin.TestMode)
	for _, testCase := range []struct {
		name    string
		uploads []adaptorUpload
		want    []string
	}{
		{"plain field", []adaptorUpload{{"image", "first"}}, []string{"first"}},
		{"array notation, several parts", []adaptorUpload{{"image[]", "first"}, {"image[]", "second"}}, []string{"first", "second"}},
		{"indexed notation, several parts", []adaptorUpload{{"image[0]", "first"}, {"image[1]", "second"}}, []string{"first", "second"}},
		{"plain field wins when both styles are sent", []adaptorUpload{{"image", "first"}, {"image[]", "second"}}, []string{"first"}},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			form, err := convertEditsRequest(t, imageEditContext(t, testCase.uploads))
			require.NoError(t, err)

			files := channel.ImagePartsFromMultipart(form)
			require.Len(t, files, len(testCase.want))
			for i, want := range testCase.want {
				assert.Equal(t, want, partContent(t, files[i]))
			}
		})
	}
}

func TestConvertImageEditRequestRequiresAnImage(t *testing.T) {
	gin.SetMode(gin.TestMode)
	_, err := convertEditsRequest(t, imageEditContext(t, nil))
	require.EqualError(t, err, "image is required")
}

func TestConvertImageEditRequestForwardsTheMask(t *testing.T) {
	gin.SetMode(gin.TestMode)
	form, err := convertEditsRequest(t, imageEditContext(t, []adaptorUpload{
		{"image", "reference"},
		{"mask", "mask-payload"},
	}))
	require.NoError(t, err)

	mask := channel.MaskPartFromMultipart(form)
	require.NotNil(t, mask)
	assert.Equal(t, "mask-payload", partContent(t, mask))
}
