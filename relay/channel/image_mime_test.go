package channel

import (
	"bytes"
	"testing"

	"github.com/stretchr/testify/assert"
)

// The upstream chooses a decoder from the part's Content-Type, and a filename
// extension is caller-supplied, so the MIME type has to come from the payload.
func TestDetectImageMimeTypeFromContent(t *testing.T) {
	webp := append([]byte("RIFF\x00\x00\x00\x00WEBPVP8 "), make([]byte, 8)...)

	for _, testCase := range []struct {
		name string
		head []byte
		want string
	}{
		{"png", []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"), MimeImagePNG},
		{"jpeg", []byte("\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01"), MimeImageJPEG},
		{"webp", webp, MimeImageWebP},
		{"gif", []byte("GIF89a\x01\x00\x01\x00"), MimeImageGIF},
		{"plain text is not an image", []byte("plain text pretending to be a png"), ""},
		{"empty payload", nil, ""},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			assert.Equal(t, testCase.want, DetectImageMimeTypeFromContent(testCase.head))
		})
	}
}

func TestDetectImageMimeTypeFromContentIgnoresPayloadBeyondTheSniffWindow(t *testing.T) {
	// Only the prefix decides: trailing bytes must not change the answer.
	head := append([]byte("\x89PNG\r\n\x1a\n"), bytes.Repeat([]byte{0x00}, ImageMimeSniffBytes*2)...)
	assert.Equal(t, MimeImagePNG, DetectImageMimeTypeFromContent(head[:ImageMimeSniffBytes]))
}
