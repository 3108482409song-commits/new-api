package common

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// The image workbench shows a model only when it is recognised as an image
// model, and the recognition is name-based. A pattern pinned to one version
// silently hides every other member of the same family, which is how a channel
// offering "gpt-image-2" ended up with an empty model list.
func TestIsImageGenerationModelCoversWholeFamilies(t *testing.T) {
	for _, modelName := range []string{
		// The gpt-image family, including the versions that do not contain
		// "gpt-image-1" as a substring.
		"gpt-image-1",
		"gpt-image-1-mini",
		"gpt-image-1.5",
		"gpt-image-2",
		"gpt-image-2.5",
		"gpt-image-2.5-flare",
		"gpt-image-2.5-sunburst",
		// Case is normalised before matching.
		"GPT-IMAGE-2",
		// Vendor-prefixed names come from reseller channels.
		"openai/gpt-image-2",
		// The other families keep working.
		"dall-e-2",
		"dall-e-3",
		"imagen-3.0-generate-002",
		"flux-1.1-pro",
		"flux.1-schnell",
	} {
		t.Run(modelName, func(t *testing.T) {
			assert.True(t, IsImageGenerationModel(modelName),
				"%q must be recognised as an image model", modelName)
		})
	}
}

func TestIsImageGenerationModelLeavesOtherModelsAlone(t *testing.T) {
	for _, modelName := range []string{
		"gpt-4o",
		"gpt-4o-mini",
		"o3-mini",
		"claude-3-5-sonnet",
		"text-embedding-3-large",
		"gpt-4-vision-preview",
	} {
		t.Run(modelName, func(t *testing.T) {
			assert.False(t, IsImageGenerationModel(modelName),
				"%q must not be treated as an image model", modelName)
		})
	}
}
