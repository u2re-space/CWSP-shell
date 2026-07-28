/*
 * Filename: index.ts
 * FullPath: apps/CWSP-shell/src/frontend/ai-slop/window/index.ts
 * Change date and time: 06.20.00_29.07.2026
 * Reason for changes: Window/tabbed stubs + EnvironmentShell re-exports.
 */
/**
 * `shells/window` path target: window / tabbed hosts (extends {@link MinimalShell}).
 * Environment is {@link ./environment-shell.ts} via `shells/window/environment`.
 */
import { MinimalShell } from "../../../../../../modules/shells/minimal-shell/src/preview";
import type { ShellId, ShellLayoutConfig } from "shells/types";

export {
    EnvironmentShell,
    createEnvironmentShell
} from "./environment-shell";

const windowLikeLayout: ShellLayoutConfig = {
    hasSidebar: false,
    hasToolbar: true,
    hasTabs: false,
    supportsMultiView: true,
    supportsWindowing: true
};

export class WindowShell extends MinimalShell {
    id: ShellId = "window";
    name = "Window";
    layout: ShellLayoutConfig = windowLikeLayout;
}

export class TabbedShell extends WindowShell {
    id: ShellId = "tabbed";
    name = "Tabbed";
    layout: ShellLayoutConfig = {
        ...windowLikeLayout,
        hasTabs: true
    };
}

export function createWindowShell(_container: HTMLElement): WindowShell {
    return new WindowShell();
}

export function createTabbedShell(_container: HTMLElement): TabbedShell {
    return new TabbedShell();
}

export default createWindowShell;
