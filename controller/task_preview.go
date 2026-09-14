package controller

import (
	"bytes"
	"encoding/base64"
	"image"
	_ "image/gif"
	"image/jpeg"
	_ "image/png"
	"strings"
	"sync"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/dto"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
)

const (
	// taskPreviewMaxSide keeps a thumbnail small enough that a full page of them
	// costs less than a single original result.
	taskPreviewMaxSide = 160
	// taskPreviewJPEGQuality trades a little fidelity for a large payload drop:
	// a 160px JPEG lands around a few kilobytes where the source PNG was megabytes.
	taskPreviewJPEGQuality = 75
	// taskPreviewCacheEntries bounds the preview cache. Entries hold only a small
	// data URL, so this is a few megabytes at worst.
	taskPreviewCacheEntries = 512
)

// taskDataImage mirrors the shape a result image is stored in. Only the two
// fields the preview needs are decoded: a result payload is multi-megabyte, so
// nothing here should pull in the rest of it.
type taskDataImage struct {
	URL     string `json:"url"`
	B64JSON string `json:"b64_json"`
}

type taskResultData struct {
	Images []taskDataImage `json:"images"`
}

var (
	taskPreviewCacheMu sync.RWMutex
	taskPreviewCache   = make(map[string]string)
	taskPreviewOrder   []string
)

func cachedTaskPreview(taskID string) (string, bool) {
	taskPreviewCacheMu.RLock()
	defer taskPreviewCacheMu.RUnlock()
	value, ok := taskPreviewCache[taskID]
	return value, ok
}

func storeTaskPreview(taskID, value string) {
	taskPreviewCacheMu.Lock()
	defer taskPreviewCacheMu.Unlock()
	// A key already present is not queued twice, so the order slice holds each
	// task exactly once and the front of it is always the oldest entry.
	if _, exists := taskPreviewCache[taskID]; !exists {
		taskPreviewOrder = append(taskPreviewOrder, taskID)
	}
	taskPreviewCache[taskID] = value
	for len(taskPreviewOrder) > taskPreviewCacheEntries {
		oldest := taskPreviewOrder[0]
		taskPreviewOrder = taskPreviewOrder[1:]
		delete(taskPreviewCache, oldest)
	}
}

// buildTaskPreview returns a small stand-in for a task's result so the list can
// ship one per row. A result is stored as a multi-megabyte base64 payload, so a
// fifteen-row page would otherwise carry tens of megabytes the list never renders
// at full size. A task that reached SUCCESS never changes its result, which is
// what makes caching the preview safe; anything unfinished has no result yet and
// gets no preview.
func buildTaskPreview(task *model.Task) string {
	if task == nil || task.Status != model.TaskStatusSuccess {
		return ""
	}
	if cached, ok := cachedTaskPreview(task.TaskID); ok {
		return cached
	}
	preview := deriveTaskPreview(task)
	// Only a real preview is cached. An empty one can come from a source that is
	// merely not ready yet (a plugin adaptor that has not registered, an artifact
	// not yet projected), and caching that would pin a blank thumbnail on the row
	// for good. Recomputing costs at most another pass over the stored payload,
	// and only for rows that have no thumbnail either way.
	if preview != "" {
		storeTaskPreview(task.TaskID, preview)
	}
	return preview
}

func deriveTaskPreview(task *model.Task) string {
	if preview := imageTaskPreview(task); preview != "" {
		return preview
	}
	return artifactTaskPreview(task)
}

// imageTaskPreview uses the first stored result image. A provider-hosted URL is
// passed through untouched: re-encoding bytes the client can fetch directly
// would only add work.
func imageTaskPreview(task *model.Task) string {
	if len(task.Data) == 0 {
		return ""
	}
	var data taskResultData
	if err := common.Unmarshal(task.Data, &data); err != nil || len(data.Images) == 0 {
		return ""
	}
	if hostedURL := strings.TrimSpace(data.Images[0].URL); hostedURL != "" {
		return hostedURL
	}
	return decodeImagePreview(data.Images[0].B64JSON)
}

// artifactTaskPreview covers results that never land in the task data: a video
// lives upstream and is reached through the artifact endpoints, which already
// mint an access token into the URL so a media tag loads it without dashboard
// credentials.
func artifactTaskPreview(task *model.Task) string {
	if legacyVideoAvailable(task) {
		if contentURL, err := service.BuildTaskArtifactContentURL(task.TaskID, "video"); err == nil {
			return contentURL
		}
		return ""
	}
	artifacts, err := projectTaskArtifacts(task)
	if err != nil {
		return ""
	}
	for _, artifact := range artifacts {
		if artifact.Type != "video" && artifact.Type != "image" {
			continue
		}
		if contentURL, buildErr := service.BuildTaskArtifactContentURL(task.TaskID, artifact.Key); buildErr == nil {
			return contentURL
		}
	}
	return ""
}

// decodeImagePreview decodes a stored base64 image, shrinks it and re-encodes it
// as a data URL. Anything unreadable yields an empty preview rather than an
// error: a row without a thumbnail is a cosmetic loss, while a failed list
// request would hide the whole history.
func decodeImagePreview(encoded string) string {
	encoded = strings.TrimSpace(encoded)
	if encoded == "" {
		return ""
	}
	// A payload may already be a data URL, in which case only the bytes matter.
	if strings.HasPrefix(encoded, "data:") {
		separator := strings.IndexByte(encoded, ',')
		if separator < 0 {
			return ""
		}
		encoded = encoded[separator+1:]
	}
	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || len(raw) == 0 {
		return ""
	}
	source, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		return ""
	}
	scaled := downscaleImage(source, taskPreviewMaxSide)
	if scaled == nil {
		return ""
	}
	var encodedPreview bytes.Buffer
	if err := jpeg.Encode(&encodedPreview, scaled, &jpeg.Options{Quality: taskPreviewJPEGQuality}); err != nil {
		return ""
	}
	return "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(encodedPreview.Bytes())
}

// downscaleImage shrinks an image until its longest side is at most maxSide.
// Nearest-neighbour sampling is deliberate: it needs no image-scaling dependency
// and a thumbnail this small cannot show the difference.
func downscaleImage(source image.Image, maxSide int) image.Image {
	bounds := source.Bounds()
	width, height := bounds.Dx(), bounds.Dy()
	if width <= 0 || height <= 0 || maxSide <= 0 {
		return nil
	}
	targetWidth, targetHeight := width, height
	if width > maxSide || height > maxSide {
		if width >= height {
			targetWidth = maxSide
			targetHeight = height * maxSide / width
		} else {
			targetHeight = maxSide
			targetWidth = width * maxSide / height
		}
	}
	if targetWidth < 1 {
		targetWidth = 1
	}
	if targetHeight < 1 {
		targetHeight = 1
	}
	if targetWidth == width && targetHeight == height {
		return source
	}
	target := image.NewRGBA(image.Rect(0, 0, targetWidth, targetHeight))
	for y := 0; y < targetHeight; y++ {
		sourceY := bounds.Min.Y + y*height/targetHeight
		for x := 0; x < targetWidth; x++ {
			sourceX := bounds.Min.X + x*width/targetWidth
			target.Set(x, y, source.At(sourceX, sourceY))
		}
	}
	return target
}

// tasksToSummaryDto is the list projection: the same rows as tasksToDto, but with
// the raw result replaced by a preview. The full payload stays reachable one task
// at a time through the detail endpoint, so a page never drags every result with
// it.
func tasksToSummaryDto(tasks []*model.Task, viewerRole int) []*dto.TaskDto {
	items := tasksToDto(tasks, false, viewerRole)
	for index, task := range tasks {
		if index >= len(items) || items[index] == nil {
			continue
		}
		items[index].Data = nil
		items[index].Preview = buildTaskPreview(task)
	}
	return items
}
