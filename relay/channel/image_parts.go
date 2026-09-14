package channel

import (
	"mime/multipart"
	"sort"
	"strings"
)

// ImagePartsFromMultipart resolves the reference-image parts of an image-edit
// form using exactly the field names the OpenAI edits protocol accepts.
//
// Validation and request re-serialization have to agree on this set. Resolving it
// in one place prevents the two failure modes that come from a divergence: a
// validator that only looked at "image" rejects a legal "image[]" upload with a
// misleading "image is required", and one that stops after the first part waves
// through a corrupt second or third part that the relay forwards upstream anyway.
func ImagePartsFromMultipart(form *multipart.Form) []*multipart.FileHeader {
	if form == nil || form.File == nil {
		return nil
	}
	// Plain field first, then the array notation; only one style is ever used.
	if parts := nonEmptyFileHeaders(form.File["image"]); len(parts) > 0 {
		return parts
	}
	if parts := nonEmptyFileHeaders(form.File["image[]"]); len(parts) > 0 {
		return parts
	}

	// Indexed notation ("image[0]", "image[1]", ...). Field names are sorted so
	// the parts keep a stable order across runs; map iteration order is not
	// defined and would otherwise shuffle the images sent upstream.
	fieldNames := make([]string, 0, len(form.File))
	for fieldName := range form.File {
		if strings.HasPrefix(fieldName, "image[") {
			fieldNames = append(fieldNames, fieldName)
		}
	}
	sort.Strings(fieldNames)

	var parts []*multipart.FileHeader
	for _, fieldName := range fieldNames {
		parts = append(parts, nonEmptyFileHeaders(form.File[fieldName])...)
	}
	return parts
}

// MaskPartFromMultipart returns the optional mask part of an image-edit form, or
// nil when the form carries none. The mask is forwarded upstream like any other
// part, so callers validating the upload must cover it too.
func MaskPartFromMultipart(form *multipart.Form) *multipart.FileHeader {
	if form == nil || form.File == nil {
		return nil
	}
	parts := nonEmptyFileHeaders(form.File["mask"])
	if len(parts) == 0 {
		return nil
	}
	return parts[0]
}

func nonEmptyFileHeaders(files []*multipart.FileHeader) []*multipart.FileHeader {
	kept := make([]*multipart.FileHeader, 0, len(files))
	for _, file := range files {
		if file != nil {
			kept = append(kept, file)
		}
	}
	return kept
}
