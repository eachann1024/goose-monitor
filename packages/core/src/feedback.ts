import { h } from "./atoms";
import { celebrate } from "./celebrate";
import { icon } from "./icons";

export const feedbackBase = "https://feedback-api.cooool.top";
const imageLimit = 20 * 1024 * 1024;
const videoLimit = 200 * 1024 * 1024;

export interface FeedbackMessage {
  id: string;
  role: "user" | "admin";
  message: string;
  at: string;
  files: {
    index: number;
    name: string;
    type: string;
    kind: "image" | "video";
  }[];
}

export interface FeedbackConversation {
  conversationId: string | null;
  messages: FeedbackMessage[];
  unreadCount: number;
}

export interface FeedbackPageRefs {
  root: HTMLElement;
  back: HTMLButtonElement;
}

function getStoredToken(key: string): string | null {
  try {
    const uVal = (window as any).utools?.dbStorage?.getItem?.(key);
    if (typeof uVal === "string" && uVal) return uVal;
  } catch {}
  try {
    const lVal = window.localStorage?.getItem(key);
    if (typeof lVal === "string" && lVal) return lVal;
  } catch {}
  return null;
}

function setStoredToken(key: string, token: string): void {
  try {
    (window as any).utools?.dbStorage?.setItem?.(key, token);
  } catch {}
  try {
    window.localStorage?.setItem(key, token);
  } catch {}
}

export function feedbackToken(): string {
  const key = "goose:feedback:token";
  const existing = getStoredToken(key);
  if (existing) {
    setStoredToken(key, existing);
    return existing;
  }
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  setStoredToken(key, token);
  const verified = getStoredToken(key);
  if (!verified) throw new Error("无法保存反馈身份，请检查本地存储后重试");
  return token;
}

export async function feedbackFetch(
  path: string,
  init: RequestInit = {},
  timeout = 25000,
): Promise<Response> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  init.signal?.addEventListener("abort", cancel, { once: true });
  if (init.signal?.aborted) controller.abort();
  const timer = setTimeout(cancel, timeout);
  try {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${feedbackToken()}`);
    const response = await fetch(`${feedbackBase}${path}`, {
      ...init,
      headers,
      signal: controller.signal,
    });
    if (!response.ok) {
      const data = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new Error(data?.error || `请求失败（${response.status}）`);
    }
    const blob = await response.blob();
    return new Response(blob, {
      status: response.status,
      headers: response.headers,
    });
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener("abort", cancel);
  }
}

let latestLoad = 0;
let currentUnread = false;

function updateFeedbackBadge(unread: boolean): void {
  const buttons = document.querySelectorAll<HTMLButtonElement>("[data-feedback-entry]");
  buttons.forEach((btn) => {
    if (unread) {
      btn.setAttribute("data-unread", "true");
      btn.setAttribute("aria-label", "反馈（有新回复）");
      btn.setAttribute("title", "反馈（有新回复）");
    } else {
      btn.removeAttribute("data-unread");
      btn.setAttribute("aria-label", "反馈");
      btn.setAttribute("title", "反馈");
    }
  });
}

export function setFeedbackUnread(value: boolean): void {
  currentUnread = value;
  updateFeedbackBadge(value);
}

export async function loadFeedback(
  project = "monitor",
  signal?: AbortSignal,
): Promise<FeedbackConversation> {
  const request = ++latestLoad;
  const response = await feedbackFetch(
    `/api/conversation?project=${encodeURIComponent(project)}`,
    { signal },
  );
  const data = (await response.json()) as FeedbackConversation;
  if (request === latestLoad) {
    setFeedbackUnread((data.unreadCount ?? 0) > 0);
  }
  return data;
}

let checking = false;
export async function checkFeedbackUnread(project = "monitor"): Promise<void> {
  if (checking || document.visibilityState === "hidden") return;
  checking = true;
  try {
    await loadFeedback(project);
  } catch {
    /* Offline retains the last known unread state. */
  } finally {
    checking = false;
  }
}

if (typeof window !== "undefined") {
  setInterval(() => {
    void checkFeedbackUnread("monitor");
  }, 60000);
  window.addEventListener("focus", () => {
    void checkFeedbackUnread("monitor");
  });
  document.addEventListener("visibilitychange", () => {
    void checkFeedbackUnread("monitor");
  });
  void checkFeedbackUnread("monitor");
}

export function mountFeedback(onOpen: () => void): HTMLButtonElement {
  const button = h("button", {
    className: "pk-settings-btn",
    attrs: {
      type: "button",
      "aria-label": currentUnread ? "反馈（有新回复）" : "反馈",
      title: currentUnread ? "反馈（有新回复）" : "反馈",
      "data-feedback-entry": "",
      ...(currentUnread ? { "data-unread": "true" } : {}),
    },
    on: { click: onOpen },
    children: [icon("message", 15, { color: "var(--fg-2)" })],
  });
  return button;
}

const mediaBlobCache = new Map<string, string>();

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString("zh-CN", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function renderAttachment(
  messageId: string,
  file: FeedbackMessage["files"][number],
): HTMLElement {
  const key = `${messageId}:${file.index}`;
  const container = h("div", { style: { display: "block" } });

  function displayMedia(url: string) {
    if (file.kind === "video") {
      const vid = h("video", {
        className: "pk-feedback-media",
        attrs: { src: url, controls: "", "aria-label": file.name },
      });
      container.appendChild(vid);
    } else {
      const img = h("img", {
        className: "pk-feedback-media",
        attrs: { src: url, alt: file.name },
      });
      const link = h("a", {
        attrs: { href: url, target: "_blank", rel: "noreferrer" },
        children: [img],
      });
      container.appendChild(link);
    }
  }

  function loadMedia() {
    container.replaceChildren();
    const cachedUrl = mediaBlobCache.get(key);
    if (cachedUrl) {
      displayMedia(cachedUrl);
      return;
    }

    const loading = h("span", {
      className: "pk-feedback-media-loading",
      text: "正在加载附件…",
    });
    container.appendChild(loading);

    const controller = new AbortController();
    void (async () => {
      try {
        const res = await feedbackFetch(
          `/api/media/${messageId}/${file.index}`,
          { signal: controller.signal },
          120000,
        );
        const blob = await res.blob();
        const objectUrl = URL.createObjectURL(blob);
        mediaBlobCache.set(key, objectUrl);
        container.replaceChildren();
        displayMedia(objectUrl);
      } catch {
        container.replaceChildren();
        const retryBtn = h("button", {
          className: "pk-feedback-media-retry",
          attrs: { type: "button" },
          text: "附件加载失败，重试",
          on: { click: () => loadMedia() },
        });
        container.appendChild(retryBtn);
      }
    })();
  }

  loadMedia();
  return container;
}

export function buildFeedbackPage(onBack: () => void, onSuccess: () => void): FeedbackPageRefs {
  const back = h("button", {
    className: "pk-settings-back",
    attrs: { type: "button", "aria-label": "返回进程列表" },
    on: { click: onBack },
    children: [
      icon("chevron-left", 16, { color: "var(--fg-2)" }),
      document.createTextNode("返回"),
    ],
  }) as HTMLButtonElement;

  const log = h("div", {
    className: "pk-feedback-log",
    attrs: { role: "log", "aria-label": "反馈聊天记录" },
  });

  const textarea = h("textarea", {
    className: "pk-input pk-grip-textarea",
    attrs: {
      placeholder: "聊聊遇到的问题或新想法，我们的回复会直接显示在这里，可随时继续对话…",
      maxlength: "4000",
      "aria-label": "反馈内容",
      rows: "2",
    },
    style: {
      height: "64px",
      minHeight: "64px",
    },
  }) as HTMLTextAreaElement;

  const gripPill = h("span", { className: "pk-grip-pill" });
  const gripHit = h("button", {
    className: "pk-grip-hit",
    attrs: {
      type: "button",
      role: "slider",
      "aria-orientation": "vertical",
      "aria-label": "调整反馈内容高度",
      "aria-valuemin": "64",
      "aria-valuemax": "64",
      "aria-valuenow": "64",
    },
    children: [gripPill],
  });

  const gripWrap = h("div", {
    className: "pk-grip-wrap",
    children: [textarea, gripHit],
  });

  const contactInput = h("input", {
    className: "pk-input",
    attrs: {
      type: "email",
      placeholder: "邮箱，选填",
      "aria-label": "邮箱，选填",
      autocomplete: "email",
    },
  }) as HTMLInputElement;

  const attachmentsContainer = h("div", {
    className: "pk-feedback-attachments",
    style: { display: "none" },
  });

  const fileImgInput = h("input", {
    attrs: {
      type: "file",
      accept: "image/jpeg,image/png,image/gif,image/webp",
      multiple: "",
      hidden: "",
      "aria-label": "图片，最多 4 张，每张 20MB",
    },
  }) as HTMLInputElement;

  const fileVidInput = h("input", {
    attrs: {
      type: "file",
      accept: "video/mp4,video/webm,video/quicktime",
      hidden: "",
      "aria-label": "视频，1 个，最大 200MB",
    },
  }) as HTMLInputElement;

  const imgBtn = h("button", {
    className: "pk-feedback-tool-btn",
    attrs: { type: "button" },
    on: { click: () => fileImgInput.click() },
    children: [
      icon("image", 15, { color: "var(--fg-2)" }),
      document.createTextNode("图片"),
    ],
  }) as HTMLButtonElement;

  const vidBtn = h("button", {
    className: "pk-feedback-tool-btn",
    attrs: { type: "button" },
    on: { click: () => fileVidInput.click() },
    children: [
      icon("video", 15, { color: "var(--fg-2)" }),
      document.createTextNode("视频"),
    ],
  }) as HTMLButtonElement;

  const status = h("p", {
    className: "pk-feedback-status",
    attrs: { role: "status" },
  });

  const sendBtn = h("button", {
    className: "pk-button pk-button--primary",
    attrs: { type: "submit" },
    text: "发送",
  }) as HTMLButtonElement;

  const actions = h("div", {
    className: "pk-feedback-actions",
    children: [imgBtn, vidBtn, status, sendBtn],
  });

  const form = h("form", {
    className: "pk-feedback-form",
    children: [
      gripWrap,
      contactInput,
      attachmentsContainer,
      actions,
      fileImgInput,
      fileVidInput,
    ],
  });

  const container = h("div", {
    className: "pk-feedback-container",
    children: [log, form],
  });

  const root = h("section", {
    className: "pk-settings-page pk-feedback-page",
    attrs: { hidden: "", "aria-label": "反馈" },
    children: [
      h("header", {
        className: "pk-settings-bar",
        children: [
          back,
          h("h1", { className: "pk-settings-heading", text: "反馈" }),
        ],
      }),
      container,
    ],
  });

  // State
  let currentMessages: FeedbackMessage[] = [];
  let initialLoaded = false;
  let followLatest = true;
  const seen = new Set<string>();
  let marking = false;
  const messageNodes = new Map<string, HTMLElement>();

  let explicitHeight: number | null = null;
  let isDraggingGrip = false;

  let selectedImages: File[] = [];
  let selectedVideo: File | null = null;
  let currentRequestId = crypto.randomUUID();

  function changed(): void {
    currentRequestId = crypto.randomUUID();
  }

  function calcMaxHeight(): number {
    const containerH = container.clientHeight || window.innerHeight;
    const room = Math.floor(containerH * 0.45);
    return Math.max(64, room);
  }

  function updateGripAria(val: number, max: number): void {
    gripHit.setAttribute("aria-valuemin", "64");
    gripHit.setAttribute("aria-valuemax", String(max));
    gripHit.setAttribute("aria-valuenow", String(Math.round(val)));
  }

  function autoGrow(): void {
    if (isDraggingGrip) return;
    const prev = textarea.style.height;
    textarea.style.height = "auto";
    const scrollH = textarea.scrollHeight;
    textarea.style.height = prev;
    const max = calcMaxHeight();
    const base = explicitHeight ?? scrollH;
    const next = Math.min(max, Math.max(64, base));
    if (explicitHeight !== null) explicitHeight = next;
    textarea.style.height = `${next}px`;
    updateGripAria(next, max);
  }

  textarea.addEventListener("input", () => {
    changed();
    autoGrow();
  });

  contactInput.addEventListener("input", () => {
    changed();
  });

  gripHit.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    gripHit.setPointerCapture(event.pointerId);
    isDraggingGrip = true;
    gripHit.classList.add("is-active");
    const startY = event.clientY;
    const startH = textarea.getBoundingClientRect().height;
    const maxRoom = calcMaxHeight();

    const onMove = (ev: PointerEvent) => {
      const next = Math.round(Math.min(maxRoom, Math.max(64, startH + (ev.clientY - startY))));
      explicitHeight = next;
      textarea.style.height = `${next}px`;
      updateGripAria(next, maxRoom);
    };

    const onEnd = () => {
      isDraggingGrip = false;
      gripHit.classList.remove("is-active");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
  });

  gripHit.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 16 : -16;
      const curH = explicitHeight ?? textarea.getBoundingClientRect().height;
      const maxRoom = calcMaxHeight();
      const next = Math.round(Math.min(maxRoom, Math.max(64, curH + delta)));
      explicitHeight = next;
      textarea.style.height = `${next}px`;
      updateGripAria(next, maxRoom);
    }
  });

  window.addEventListener("resize", () => {
    if (!isDraggingGrip) {
      const max = calcMaxHeight();
      const curH = explicitHeight ?? textarea.getBoundingClientRect().height;
      const next = Math.min(max, Math.max(64, curH));
      if (explicitHeight !== null) explicitHeight = next;
      textarea.style.height = `${next}px`;
      updateGripAria(next, max);
    }
  });

  function renderAttachments(): void {
    attachmentsContainer.replaceChildren();
    const hasItems = selectedImages.length > 0 || !!selectedVideo;
    attachmentsContainer.style.display = hasItems ? "flex" : "none";

    selectedImages.forEach((file, index) => {
      const pill = h("span", {
        className: "pk-attachment-pill",
        children: [
          h("span", {
            className: "pk-attachment-name",
            attrs: { title: file.name },
            text: file.name,
          }),
          h("button", {
            className: "pk-attachment-remove",
            attrs: { type: "button", "aria-label": `移除 ${file.name}` },
            text: "×",
            on: {
              click: () => {
                selectedImages = selectedImages.filter((_, i) => i !== index);
                changed();
                renderAttachments();
              },
            },
          }),
        ],
      });
      attachmentsContainer.appendChild(pill);
    });

    if (selectedVideo) {
      const vid = selectedVideo;
      const pill = h("span", {
        className: "pk-attachment-pill",
        children: [
          h("span", {
            className: "pk-attachment-name",
            attrs: { title: vid.name },
            text: vid.name,
          }),
          h("button", {
            className: "pk-attachment-remove",
            attrs: { type: "button", "aria-label": `移除 ${vid.name}` },
            text: "×",
            on: {
              click: () => {
                selectedVideo = null;
                changed();
                renderAttachments();
              },
            },
          }),
        ],
      });
      attachmentsContainer.appendChild(pill);
    }
  }

  fileImgInput.addEventListener("change", () => {
    const chosen = Array.from(fileImgInput.files || []);
    fileImgInput.value = "";
    if (!chosen.length) return;
    selectedImages = [...selectedImages, ...chosen].slice(0, 4);
    changed();
    renderAttachments();
  });

  fileVidInput.addEventListener("change", () => {
    const chosen = fileVidInput.files?.[0] || null;
    fileVidInput.value = "";
    if (!chosen) return;
    selectedVideo = chosen;
    changed();
    renderAttachments();
  });

  log.addEventListener("scroll", () => {
    followLatest = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  });

  async function mark(): Promise<void> {
    if (
      marking ||
      root.hidden ||
      document.visibilityState !== "visible" ||
      !document.hasFocus()
    ) {
      return;
    }
    let last: FeedbackMessage | undefined;
    for (const entry of currentMessages) {
      if (!seen.has(entry.id)) break;
      last = entry;
    }
    if (!last || log.dataset.read === last.id) return;
    marking = true;
    try {
      await feedbackFetch("/api/conversation/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project: "monitor", messageId: last.id }),
      });
      log.dataset.read = last.id;
      await loadFeedback("monitor");
    } catch {
      /* Keep unread until server accepts */
    } finally {
      marking = false;
    }
  }

  const observer = new IntersectionObserver(
    (entries) => {
      if (root.hidden || document.visibilityState !== "visible" || !document.hasFocus()) return;
      for (const entry of entries) {
        if (
          entry.isIntersecting &&
          entry.target instanceof HTMLElement &&
          entry.target.dataset.messageId
        ) {
          seen.add(entry.target.dataset.messageId);
        }
      }
      void mark();
    },
    { root: log, threshold: 0.01 },
  );

  function renderMessages(messages: FeedbackMessage[], forceScrollBottom = false): void {
    currentMessages = messages;
    initialLoaded = true;
    messageNodes.clear();
    log.replaceChildren();

    if (!messages.length) {
      const empty = h("p", {
        className: "pk-feedback-empty",
        text: "遇到的问题或想要的功能都可以直接留言，我们的回复会显示在这里，随时继续对话。",
      });
      log.appendChild(empty);
      return;
    }

    messages.forEach((entry) => {
      const timeEl = h("time", {
        className: "pk-feedback-time",
        attrs: { dateTime: entry.at },
        text: formatTime(entry.at),
      });
      const textEl = h("p", {
        className: "pk-feedback-text",
        text: entry.message,
      });
      const bubbleChildren: HTMLElement[] = [timeEl, textEl];
      entry.files.forEach((file) => {
        bubbleChildren.push(renderAttachment(entry.id, file));
      });

      const bubble = h("div", {
        className: `pk-feedback-bubble pk-feedback-bubble--${entry.role}`,
        children: bubbleChildren,
      });
      const wrap = h("div", {
        className: `pk-feedback-msg-wrap pk-feedback-msg-wrap--${entry.role}`,
        attrs: { "data-message-id": entry.id },
        children: [bubble],
      });
      messageNodes.set(entry.id, wrap);
      log.appendChild(wrap);
    });

    observer.disconnect();
    messageNodes.forEach((node) => observer.observe(node));

    if (forceScrollBottom || followLatest) {
      log.scrollTop = log.scrollHeight;
      followLatest = true;
    }
  }

  // Initial loading state
  log.appendChild(
    h("p", {
      className: "pk-feedback-empty",
      text: "正在加载…",
    }),
  );

  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let activeAbort: AbortController | null = null;

  async function refreshConversation(): Promise<void> {
    if (root.hidden || document.visibilityState === "hidden") return;
    activeAbort?.abort();
    activeAbort = new AbortController();
    try {
      const conv = await loadFeedback("monitor", activeAbort.signal);
      renderMessages(conv.messages);
      void mark();
    } catch {
      if (!initialLoaded) {
        renderMessages([]);
      }
    }
  }

  function onHiddenChange(): void {
    if (!root.hidden) {
      void refreshConversation();
      if (!pollTimer) {
        pollTimer = setInterval(() => {
          void refreshConversation();
        }, 15000);
      }
    } else {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      activeAbort?.abort();
    }
  }

  const mutObserver = new MutationObserver(() => {
    onHiddenChange();
  });
  mutObserver.observe(root, { attributes: true, attributeFilter: ["hidden"] });

  window.addEventListener("focus", () => {
    if (!root.hidden) {
      observer.disconnect();
      messageNodes.forEach((node) => observer.observe(node));
      void refreshConversation();
      void mark();
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (!root.hidden && document.visibilityState !== "hidden") {
      observer.disconnect();
      messageNodes.forEach((node) => observer.observe(node));
      void refreshConversation();
      void mark();
    }
  });

  setInterval(() => {
    if (!root.hidden) void mark();
  }, 10000);

  let sending = false;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (sending) return;
    const msg = textarea.value.trim();
    if (!msg) {
      status.textContent = "请输入消息";
      return;
    }
    if (selectedImages.some((f) => f.size > imageLimit)) {
      status.textContent = "单张图片不能超过 20MB";
      return;
    }
    if (selectedVideo && selectedVideo.size > videoLimit) {
      status.textContent = "视频不能超过 200MB";
      return;
    }

    sending = true;
    sendBtn.disabled = true;
    imgBtn.disabled = true;
    vidBtn.disabled = true;
    sendBtn.textContent = "发送中…";
    status.textContent = "";

    const body = new FormData();
    body.set("project", "monitor");
    body.set("token", feedbackToken());
    body.set("requestId", currentRequestId);
    body.set("message", msg);
    body.set("contact", contactInput.value.trim());
    body.set("leave_blank", "");
    const username = (window as any).utools?.getUser?.()?.nickname;
    if (username) body.set("username", username);
    selectedImages.forEach((file) => body.append("images", file));
    if (selectedVideo) body.set("video", selectedVideo);

    try {
      const res = await feedbackFetch(
        "/api/feedback",
        { method: "POST", body },
        120000,
      );
      const result = (await res.json().catch(() => null)) as {
        ok?: boolean;
        error?: string;
      } | null;
      if (!result?.ok) throw new Error(result?.error || "发送失败，请稍后重试");

      changed();
      textarea.value = "";
      explicitHeight = null;
      textarea.style.height = "64px";
      updateGripAria(64, calcMaxHeight());
      selectedImages = [];
      selectedVideo = null;
      renderAttachments();
      status.textContent = "";

      onSuccess();
      celebrate();

      const conversation = await loadFeedback("monitor");
      renderMessages(conversation.messages, true);
    } catch (error) {
      status.textContent =
        error instanceof Error ? error.message : "网络不通，请稍后重试";
    } finally {
      sending = false;
      sendBtn.disabled = false;
      imgBtn.disabled = false;
      vidBtn.disabled = false;
      sendBtn.textContent = "发送";
    }
  });

  return { root, back };
}
