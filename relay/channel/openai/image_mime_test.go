package openai

import (
	"bytes"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"io"
	"mime/multipart"
	"testing"

	"github.com/QuantumNous/new-api/relay/channel"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// testMultipartFile is the smallest thing satisfying multipart.File: bytes.Reader
// already provides Read/ReadAt/Seek, so only Close has to be added.
type testMultipartFile struct {
	*bytes.Reader
}

func (testMultipartFile) Close() error { return nil }

func testImageBytes(t *testing.T, format string) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 8, 8))
	img.Set(0, 0, color.RGBA{R: 0x10, G: 0x20, B: 0x30, A: 0xff})

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

// The upstream picks its decoder from the part's Content-Type, and the filename
// comes from the caller, so the payload has to win over the extension.
func TestDetectImageMimeTypePrefersContentOverExtension(t *testing.T) {
	pngBytes := testImageBytes(t, "png")
	jpegBytes := testImageBytes(t, "jpeg")
	inconclusive := []byte("no recognisable signature in this payload")

	for _, testCase := range []struct {
		name     string
		data     []byte
		filename string
		want     string
	}{
		{"png mislabelled as .jpg", pngBytes, "reference.jpg", channel.MimeImagePNG},
		{"jpeg mislabelled as .png", jpegBytes, "reference.png", channel.MimeImageJPEG},
		{"content wins over an unrelated extension", pngBytes, "reference.bin", channel.MimeImagePNG},
		{"extension is only the fallback", inconclusive, "reference.webp", channel.MimeImageWebP},
		{"jpeg alias falls back correctly", inconclusive, "reference.jpeg", channel.MimeImageJPEG},
		{"unknown extension falls back to png", inconclusive, "reference.bin", channel.MimeImagePNG},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			file := testMultipartFile{bytes.NewReader(testCase.data)}

			got, err := detectImageMimeType(file, testCase.filename)
			require.NoError(t, err)
			assert.Equal(t, testCase.want, got)

			// Sniffing must not consume the payload: the caller streams the very
			// same file into the multipart request it rebuilds.
			remaining, err := io.ReadAll(file)
			require.NoError(t, err)
			assert.Equal(t, testCase.data, remaining)
		})
	}
}

func TestDetectImageMimeTypeReportsUnreadablePayload(t *testing.T) {
	_, err := detectImageMimeType(failingMultipartFile{}, "reference.png")
	require.Error(t, err)
}

// failingMultipartFile fails on the first read, standing in for a temp file that
// disappears between opening and sniffing.
type failingMultipartFile struct{}

func (failingMultipartFile) Read([]byte) (int, error) { return 0, io.ErrClosedPipe }
func (failingMultipartFile) ReadAt([]byte, int64) (int, error) {
	return 0, io.ErrClosedPipe
}
func (failingMultipartFile) Seek(int64, int) (int64, error) { return 0, io.ErrClosedPipe }
func (failingMultipartFile) Close() error                   { return nil }

var _ multipart.File = failingMultipartFile{}
