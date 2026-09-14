package channel

import (
	"bytes"
	"mime/multipart"
	"net/textproto"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// buildForm assembles a multipart form with the given file fields, so the
// resolvers can be exercised without a live HTTP request.
func buildForm(t *testing.T, files map[string][]string) *multipart.Form {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	for fieldName, filenames := range files {
		for _, filename := range filenames {
			header := make(textproto.MIMEHeader)
			header.Set("Content-Disposition",
				`form-data; name="`+fieldName+`"; filename="`+filename+`"`)
			header.Set("Content-Type", "image/png")
			part, err := writer.CreatePart(header)
			require.NoError(t, err)
			_, err = part.Write([]byte("payload of " + fieldName + "/" + filename))
			require.NoError(t, err)
		}
	}
	require.NoError(t, writer.Close())

	form, err := multipart.NewReader(&body, writer.Boundary()).ReadForm(1 << 20)
	require.NoError(t, err)
	t.Cleanup(func() { _ = form.RemoveAll() })
	return form
}

func filenamesOf(files []*multipart.FileHeader) []string {
	if len(files) == 0 {
		return nil
	}
	names := make([]string, 0, len(files))
	for _, file := range files {
		names = append(names, file.Filename)
	}
	return names
}

func TestImagePartsFromMultipartAcceptsEveryFieldNameTheProtocolUses(t *testing.T) {
	for _, testCase := range []struct {
		name  string
		files map[string][]string
		want  []string
	}{
		{"plain image", map[string][]string{"image": {"a.png"}}, []string{"a.png"}},
		{"several plain images", map[string][]string{"image": {"a.png", "b.png"}}, []string{"a.png", "b.png"}},
		{"array notation", map[string][]string{"image[]": {"a.png", "b.png"}}, []string{"a.png", "b.png"}},
		{"indexed notation", map[string][]string{"image[0]": {"a.png"}, "image[1]": {"b.png"}}, []string{"a.png", "b.png"}},
		{
			"plain field wins when both styles are present",
			map[string][]string{"image": {"plain.png"}, "image[]": {"array.png"}},
			[]string{"plain.png"},
		},
		{
			"array notation wins over indexed notation when non-empty",
			map[string][]string{"image[]": {"array.png"}, "image[0]": {"indexed.png"}},
			[]string{"array.png"},
		},
		{"mask alone is not a reference image", map[string][]string{"mask": {"m.png"}}, nil},
		{"no file fields", nil, nil},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			form := buildForm(t, testCase.files)
			assert.Equal(t, testCase.want, filenamesOf(ImagePartsFromMultipart(form)))
		})
	}
}

func TestImagePartsFromMultipartHandleNilForm(t *testing.T) {
	assert.Nil(t, ImagePartsFromMultipart(nil))
	assert.Nil(t, ImagePartsFromMultipart(&multipart.Form{}))
}

func TestMaskPartFromMultipart(t *testing.T) {
	form := buildForm(t, map[string][]string{"image": {"a.png"}, "mask": {"m.png"}})
	mask := MaskPartFromMultipart(form)
	require.NotNil(t, mask)
	assert.Equal(t, "m.png", mask.Filename)

	assert.Nil(t, MaskPartFromMultipart(buildForm(t, map[string][]string{"image": {"a.png"}})))
	assert.Nil(t, MaskPartFromMultipart(nil))
}
