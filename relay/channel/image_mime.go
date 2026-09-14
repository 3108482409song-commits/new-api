package channel

import "net/http"

// Image part MIME types the adaptors recognise when they rebuild a multipart
// request. The upstream keys its decoder off the part's Content-Type, so the
// value has to describe the bytes that are actually sent.
const (
	MimeImagePNG  = "image/png"
	MimeImageJPEG = "image/jpeg"
	MimeImageWebP = "image/webp"
	MimeImageGIF  = "image/gif"
)

// ImageMimeSniffBytes is how much of a payload is inspected before deciding on
// a Content-Type. It matches the prefix http.DetectContentType looks at.
const ImageMimeSniffBytes = 512

// DetectImageMimeTypeFromContent sniffs an image MIME type from the leading
// bytes of a payload and returns "" when the prefix is inconclusive.
//
// A filename extension is supplied by the caller and can disagree with the
// payload it labels, so adaptors that rebuild a multipart request should decide
// from the content first and only fall back to the extension when this reports
// nothing.
func DetectImageMimeTypeFromContent(head []byte) string {
	declared := http.DetectContentType(head)
	switch declared {
	case MimeImagePNG, MimeImageJPEG, MimeImageWebP, MimeImageGIF:
		return declared
	default:
		return ""
	}
}
