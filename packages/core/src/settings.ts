/* 设置页：独立整页、竖排开关。偏好读写走 bridge pref。 */
import { h } from "./atoms";
import { icon } from "./icons";
import { button } from "./ui";
import {
  isTelemetryEnabled,
  setTelemetryEnabled,
  subscribeTelemetry,
  telemetryPreview,
} from "./telemetry";

export const SHOW_PID_PREF_KEY = "pk_show_pid";
export const SHOW_PORTS_PREF_KEY = "pk_show_ports";

export type DisplayPrefKey = "showPid" | "showPorts";

export interface DisplayPrefs {
  showPid: boolean;
  showPorts: boolean;
}

export function restoreBool(value: string | null, fallback: boolean): boolean {
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  return fallback;
}

export function persistBool(value: boolean): string {
  return value ? "1" : "0";
}

export function restoreDisplayPrefs(pid: string | null, ports: string | null): DisplayPrefs {
  return {
    showPid: restoreBool(pid, false),
    showPorts: restoreBool(ports, true),
  };
}

/** 界面分类是窗口应用，不展示服务端口。 */
export function portsVisibleOnPage(showPorts: boolean, category: string): boolean {
  return showPorts && category !== "gui";
}

function switchControl(checked: boolean, label: string, onToggle: () => void): HTMLButtonElement {
  const thumb = h("span", { className: "pk-switch-thumb" });
  return h("button", {
    className: "pk-switch",
    attrs: {
      type: "button",
      role: "switch",
      "aria-checked": checked ? "true" : "false",
      "aria-label": label,
    },
    on: { click: onToggle },
    children: [thumb],
  }) as HTMLButtonElement;
}

function settingRow(
  title: string,
  detail: string,
  checked: boolean,
  onToggle: () => void,
): { row: HTMLElement; sw: HTMLButtonElement } {
  const sw = switchControl(checked, title, onToggle);
  const row = h("div", {
    className: "pk-setting-row",
    children: [
      h("div", {
        className: "pk-setting-copy",
        children: [
          h("div", { className: "pk-setting-title", text: title }),
          h("div", { className: "pk-setting-detail", text: detail }),
        ],
      }),
      sw,
    ],
  });
  return { row, sw };
}

export interface SettingsPageRefs {
  root: HTMLElement;
  back: HTMLButtonElement;
  pidSwitch: HTMLButtonElement;
  portsSwitch: HTMLButtonElement;
  telemetrySwitch: HTMLButtonElement;
  sync(prefs: DisplayPrefs): void;
  closePreview(): boolean;
}

function buildTelemetryPreviewModal(onClose: () => void): {
  backdrop: HTMLElement;
  closeBtn: HTMLButtonElement;
  refresh: () => void;
} {
  const titleId = "pk-telemetry-preview-title";
  const pre = h("pre", {
    className: "pk-telemetry-pre selectable",
    attrs: { "aria-readonly": "true", tabindex: "0" },
  });
  const closeBtn = h("button", {
    className: "pk-modal-close",
    attrs: { type: "button", "aria-label": "关闭预览" },
    on: { click: onClose },
    children: [icon("x", 15)],
  }) as HTMLButtonElement;
  const card = h("div", {
    className: "pk-modal-card",
    attrs: { role: "dialog", "aria-modal": "true", "aria-labelledby": titleId },
    on: { click: (e: MouseEvent) => e.stopPropagation() },
    children: [
      h("div", {
        className: "pk-modal-head",
        children: [
          h("h2", { className: "pk-modal-title", attrs: { id: titleId }, text: "上报内容预览" }),
          closeBtn,
        ],
      }),
      pre,
    ],
  });
  const backdrop = h("div", {
    className: "pk-modal-backdrop",
    attrs: { hidden: "" },
    on: { click: onClose },
    children: [card],
  });
  const refresh = () => {
    pre.textContent = JSON.stringify(telemetryPreview(), null, 2);
  };
  return { backdrop, closeBtn, refresh };
}

export function buildSettingsPage(
  prefs: DisplayPrefs,
  onBack: () => void,
  onChange: (key: DisplayPrefKey, value: boolean) => void,
): SettingsPageRefs {
  const pid = settingRow(
    "显示 PID",
    "进程号常显在名称旁，方便终端对照。",
    prefs.showPid,
    () => onChange("showPid", pid.sw.getAttribute("aria-checked") !== "true"),
  );
  const ports = settingRow(
    "显示服务端口",
    "Java、Go、Node、Vite、Bun、Python 等正在监听的端口。",
    prefs.showPorts,
    () => onChange("showPorts", ports.sw.getAttribute("aria-checked") !== "true"),
  );
  const telemetry = settingRow(
    "发送匿名使用统计",
    "只统计功能使用次数和报错类型，不含进程名、路径、窗口标题或网络地址，关闭后会删除匿名编号。",
    isTelemetryEnabled(),
    () => setTelemetryEnabled(telemetry.sw.getAttribute("aria-checked") !== "true"),
  );

  let previewBtn!: HTMLButtonElement;
  const closePreview = (): boolean => {
    if (modal.backdrop.hidden) return false;
    modal.backdrop.hidden = true;
    previewBtn.focus();
    return true;
  };
  const modal = buildTelemetryPreviewModal(() => { closePreview(); });
  previewBtn = button("查看上报内容", {
    onClick: () => {
      modal.refresh();
      modal.backdrop.hidden = false;
      modal.closeBtn.focus();
    },
  });

  const syncTelemetry = () => {
    telemetry.sw.setAttribute("aria-checked", isTelemetryEnabled() ? "true" : "false");
    if (!modal.backdrop.hidden) modal.refresh();
  };
  subscribeTelemetry(syncTelemetry);

  const back = h("button", {
    className: "pk-settings-back",
    attrs: { type: "button", "aria-label": "返回进程列表" },
    on: { click: () => { closePreview(); onBack(); } },
    children: [icon("chevron-left", 16, { color: "var(--fg-2)" } as any), document.createTextNode("返回")],
  }) as HTMLButtonElement;
  const header = h("header", {
    className: "pk-settings-bar",
    children: [
      back,
      h("h1", { className: "pk-settings-heading", text: "设置" }),
    ],
  });
  const displayGroup = h("div", {
    className: "pk-settings-group",
    attrs: { role: "group", "aria-label": "显示" },
    children: [
      h("div", { className: "pk-settings-label", text: "显示" }),
      h("div", { className: "pk-settings-rows", children: [pid.row, ports.row] }),
    ],
  });
  const privacyGroup = h("div", {
    className: "pk-settings-group",
    attrs: { role: "group", "aria-label": "隐私与统计" },
    children: [
      h("div", { className: "pk-settings-label", text: "隐私与统计" }),
      h("div", { className: "pk-settings-rows", children: [telemetry.row] }),
      h("div", { className: "pk-settings-actions", children: [previewBtn] }),
    ],
  });
  const list = h("div", {
    className: "pk-settings-list",
    children: [displayGroup, privacyGroup],
  });
  const root = h("section", {
    className: "pk-settings-page",
    attrs: { hidden: "", "aria-label": "设置" },
    children: [header, list, modal.backdrop],
  });
  return {
    root,
    back,
    pidSwitch: pid.sw,
    portsSwitch: ports.sw,
    telemetrySwitch: telemetry.sw,
    sync(next) {
      pid.sw.setAttribute("aria-checked", next.showPid ? "true" : "false");
      ports.sw.setAttribute("aria-checked", next.showPorts ? "true" : "false");
      syncTelemetry();
    },
    closePreview,
  };
}
