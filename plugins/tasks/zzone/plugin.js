// Transparent proxy driver for an OpenAI-compatible /v1/videos upstream.
//
// Wire contract observed against the upstream (all verified by real calls):
//   POST {base}/v1/videos          -> {id, task_id, object, model, status, progress, created_at, result?}
//   GET  {base}/v1/videos/{id}     -> same, plus completed_at / error when terminal
//   GET  {base}/v1/videos/{id}/content -> the video bytes (400 while not complete)
//
// The client never sees the upstream. The host owns the public task identity and
// rebuilds id/object/model/status/progress/created_at/completed_at itself, so
// render() only supplies the failure envelope and a gateway-relative content
// path. It must never return the raw upstream body, which would expose the
// upstream's own fields and video address.

export const meta = {
  apiVersion: 1,
  key: "zzone",
  name: "OpenAI-compatible video upstream",
  description: {
    en: "Transparent proxy for an upstream that speaks the OpenAI /v1/videos protocol",
    zh: "透明代理：上游使用 OpenAI /v1/videos 协议",
  },
  version: "1.0.0",
  // Empty on purpose: the Task Plugin channel type is implicit, and this driver
  // must only ever run behind that channel type.
  channelTypes: [],
  author: { name: "local" },
  models: [
    "kling-video-v3",
    "kling-video-v3-omni",
    "kling-video-v3-turbo",
    "grok-imagine-video",
    "grok-imagine-video-1.5-preview",
    "seedance2.0-A",
    "seedance2.5-A",
  ],
  fetchMode: "per_task",
  usageSchema: {
    seconds: {
      type: "number",
      unit: "second",
      description: { en: "Requested video duration in seconds", zh: "请求的视频时长（秒）" },
    },
    resolution: {
      enum: ["720p", "1080p"],
      enumLabels: { "720p": { en: "720p", zh: "720p" }, "1080p": { en: "1080p", zh: "1080p" } },
      description: { en: "Output resolution", zh: "输出分辨率" },
    },
  },
  protocols: ["openai_video"],
};

function trimmed(value) {
  return String(value === undefined || value === null ? "" : value).trim();
}

function authHeaders(ctx) {
  return { Authorization: "Bearer " + ctx.apiKey };
}

// ---------------------------------------------------------------- driver hooks

export function buildSubmitRequest(ctx) {
  const req = ctx.requestBody || {};
  if (!trimmed(req.prompt)) throw new Error("field prompt is required");
  const body = Object.assign({}, req);
  // ctx.upstreamModel is the channel-mapped machine identity; ctx.model is the
  // alias the client used. The upstream only accepts the real name.
  body.model = ctx.upstreamModel || ctx.model;
  return {
    url: ctx.baseUrl + "/v1/videos",
    method: "POST",
    headers: Object.assign(authHeaders(ctx), { "Content-Type": "application/json" }),
    body: body,
  };
}

export function parseSubmitResponse(ctx, resp) {
  const body = resp.body || {};
  // The upstream sets both fields to the same value.
  const taskId = body.id || body.task_id;
  if (!trimmed(taskId)) throw new Error("task_id is empty");
  return { taskId: taskId, taskData: body };
}

export function buildQueryRequest(ctx) {
  // ctx.taskId is the upstream task id, not the host's public task id.
  return {
    url: ctx.baseUrl + "/v1/videos/" + encodeURIComponent(ctx.taskId),
    method: "GET",
    headers: authHeaders(ctx),
  };
}

export function parseTaskResult(ctx, body) {
  const statuses = {
    queued: "QUEUED",
    pending: "QUEUED",
    submitted: "QUEUED",
    processing: "IN_PROGRESS",
    in_progress: "IN_PROGRESS",
    running: "IN_PROGRESS",
    completed: "SUCCESS",
    succeeded: "SUCCESS",
    failed: "FAILURE",
    cancelled: "FAILURE",
    canceled: "FAILURE",
  };
  const raw = trimmed(body.status).toLowerCase();
  const mapped = statuses[raw];
  const result = { status: mapped || "UNKNOWN" };
  if (!mapped) {
    // "unknown" is what the upstream reports before its provider has picked the
    // task up, so treat it as still-queued instead of a hard failure.
    if (raw === "unknown") result.status = "QUEUED";
    else result.reason = "unrecognized status: " + trimmed(body.status);
  }
  const progress = Number(body.progress);
  if (Number.isFinite(progress) && progress > 0 && progress < 100) result.progress = progress + "%";
  if (result.status === "FAILURE") {
    const message = body.error && body.error.message;
    result.reason = trimmed(message) || "task failed";
  }
  return result;
}

export function listArtifacts(task) {
  return task.status === "SUCCESS" ? [{ key: "video", type: "video", mimeType: "video/mp4" }] : [];
}

export function buildContentRequest(ctx) {
  if (ctx.artifactKey !== "video") throw new Error("artifact_not_found");
  return {
    url: ctx.baseUrl + "/v1/videos/" + encodeURIComponent(ctx.upstreamTaskId) + "/content",
    method: ctx.clientRequest && ctx.clientRequest.method ? ctx.clientRequest.method : "GET",
    headers: authHeaders(ctx),
  };
}

export function extractUsage(ctx) {
  const req = ctx.requestBody || {};
  const seconds = Number(req.seconds === undefined ? req.duration : req.seconds);
  const facts = {};
  if (Number.isFinite(seconds) && seconds > 0) facts.seconds = Math.min(seconds, 15);
  const resolution = trimmed(req.resolution);
  if (resolution) facts.resolution = resolution;
  return facts;
}

export function extractUsageOnComplete(task, taskResult, body) {
  const facts = {};
  const seconds = Number((body || {}).seconds || (body || {}).duration);
  if (Number.isFinite(seconds) && seconds > 0) facts.seconds = Math.min(seconds, 15);
  const resolution = trimmed((body || {}).resolution);
  if (resolution) facts.resolution = resolution;
  return facts;
}

// -------------------------------------------------------------- protocol hooks

export const protocols = {
  openai_video: {
    decodeRequest: function (ctx) {
      if (!ctx.body || ctx.body.kind !== "json") throw new Error("JSON body required");
      const req = ctx.body.value;
      if (!req || typeof req !== "object" || Array.isArray(req)) throw new Error("request body must be an object");
      const prompt = trimmed(req.prompt);
      if (!prompt) throw new Error("prompt is required");

      const seconds = req.seconds === undefined ? req.duration : req.seconds;
      if (seconds !== undefined) {
        const value = Number(seconds);
        if (!Number.isFinite(value) || value < 1 || value > 15) throw new Error("seconds must be between 1 and 15");
      }
      const resolution = trimmed(req.resolution);
      if (resolution && !["720p", "1080p"].includes(resolution)) throw new Error("resolution must be 720p or 1080p");
      if (req.images !== undefined && !Array.isArray(req.images)) throw new Error("images must be an array");

      return {
        kind: "submit",
        model: ctx.model,
        action: Array.isArray(req.images) && req.images.length ? "image_to_video" : "text_to_video",
        requestBody: Object.assign({}, req, { model: ctx.model }),
      };
    },

    // The host overwrites id, object, model, status, progress, created_at and
    // completed_at, and deletes task_id from whatever this returns. Only supply
    // the fields it does not own. The upstream snapshot is never returned, so no
    // upstream field or address can reach the client.
    render: function (ctx, task) {
      const output = {};
      if (task.status === "FAILURE") {
        output.error = {
          code: "video_generation_failed",
          message: trimmed(task.fail_reason) || "The video generation task failed.",
        };
      }
      if (task.status === "SUCCESS") {
        // Gateway-relative path; the client resolves it against the host it
        // already called. The upstream address never leaves the server.
        output.url = "/v1/videos/" + encodeURIComponent(task.task_id) + "/content";
      }
      return output;
    },
  },
};
