import { h } from "./atoms";
import { celebrate } from "./celebrate";
import { icon } from "./icons";
import { button, textControl, formField, filePicker } from "./ui";

const endpoint = "https://feedback-api.cooool.top/api/feedback";
const imageLimit = 20 * 1024 * 1024;
const videoLimit = 200 * 1024 * 1024;

export function mountFeedback(onOpen: () => void): HTMLButtonElement {
  const button = h("button", {
    className: "pk-settings-btn",
    attrs: { type: "button", "aria-label": "反馈", title: "反馈", "data-feedback-entry": "" },
    on: { click: onOpen },
    children: [icon("message", 15, { color: "var(--fg-2)" })],
  });
  return button;
}

export interface FeedbackPageRefs {
  root: HTMLElement;
  back: HTMLButtonElement;
}

export function buildFeedbackPage(onBack: () => void, onSuccess: () => void): FeedbackPageRefs {
  const back = h("button", {
    className: "pk-settings-back",
    attrs: { type: "button", "aria-label": "返回进程列表" },
    on: { click: onBack },
    children: [icon("chevron-left", 16, { color: "var(--fg-2)" }), document.createTextNode("返回")],
  });
  const message = textControl("textarea", {
    maxlength: "4000", placeholder: "遇到的问题或想要的功能",
  });
  const contact = textControl("input", {
    type: "email", placeholder: "邮箱，选填", autocomplete: "email",
  });
  const images = filePicker({
    label: "图片", accept: "image/jpeg,image/png,image/gif,image/webp", limit: 4, hint: "最多 4 张，每张 20MB",
  });
  const video = filePicker({
    label: "视频", accept: "video/mp4,video/webm,video/quicktime", limit: 1, hint: "1 个，最大 200MB",
  });
  const status = h("p", { className: "pk-feedback-status", attrs: { role: "status" } });
  const send = button("发送", { primary: true, type: "submit" });
  const fields = h("fieldset", {
    className: "pk-feedback-fields",
    attrs: { "aria-label": "反馈内容" },
    children: [formField("正文", message), formField("邮箱，选填", contact), images.root, video.root],
  });
  const form = h("form", {
    className: "pk-feedback-form",
    on: { submit: (event) => { void deliver(event, message, contact, images.input, video.input, status, send, onSuccess, () => { images.reset(); video.reset(); onBack(); }); } },
    children: [
      fields,
      h("div", { className: "pk-feedback-actions", children: [status, send] }),
    ],
  });
  const root = h("section", {
    className: "pk-settings-page pk-feedback-page",
    attrs: { hidden: "", "aria-label": "反馈" },
    children: [
      h("header", {
        className: "pk-settings-bar",
        children: [back, h("h1", { className: "pk-settings-heading", text: "反馈" })],
      }),
      h("div", { className: "pk-settings-list", children: [form] }),
    ],
  });
  return { root, back };
}

async function deliver(
  event: Event,
  message: HTMLTextAreaElement,
  contact: HTMLInputElement,
  images: HTMLInputElement,
  video: HTMLInputElement,
  status: HTMLElement,
  send: HTMLButtonElement,
  onSuccess: () => void,
  onBack: () => void,
): Promise<void> {
  event.preventDefault();
  if (send.disabled) return;
  const text = message.value.trim();
  const files = Array.from(images.files || []).slice(0, 4);
  const clip = video.files?.[0] || null;
  if (text.length < 4) { status.textContent = "请至少写 4 个字"; return; }
  if (files.some((file) => file.size > imageLimit)) { status.textContent = "单张图片不能超过 20MB"; return; }
  if (clip && clip.size > videoLimit) { status.textContent = "视频不能超过 200MB"; return; }
  const body = new FormData();
  body.set("project", "monitor");
  body.set("message", text);
  body.set("contact", contact.value.trim());
  body.set("leave_blank", "");
  files.forEach((file) => body.append("images", file));
  if (clip) body.set("video", clip);
  send.disabled = true;
  const fields = send.form?.querySelector("fieldset");
  if (fields) fields.disabled = true;
  send.textContent = "发送中…";
  status.textContent = "正在发送";
  try {
    const response = await fetch(endpoint, { method: "POST", body });
    const data = await response.json().catch(() => null) as { ok?: boolean; error?: string } | null;
    if (!response.ok || !data?.ok) { status.textContent = data?.error || "发送失败，请稍后再试"; return; }
    message.value = "";
    contact.value = "";
    images.value = "";
    video.value = "";
    status.textContent = "";
    onSuccess();
    celebrate();
    onBack();
  } catch {
    status.textContent = "网络不通，请稍后再试";
  } finally {
    send.disabled = false;
    if (fields) fields.disabled = false;
    send.textContent = "发送";
  }
}
