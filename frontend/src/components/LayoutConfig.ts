import { lazy } from "react";

// "call" intentionally absent — the split-pane picker now treats Call as
// part of Chat (audio/video icons live in [ChatHeader](../chat/components/ChatHeader.tsx)).
// The /call route is still reachable directly via App.tsx for legacy bookmarks.
export type AppKey =
  | "home"
  | "emails"
  | "chat"
  | "scheduler"
  | "drive"
  | "notes"
  | "tasks"
  | "aichat"
  | "about";

const HomeView = lazy(() => import("../home/Home"));
const EmailsView = lazy(() => import("../emails/Emails"));
const ChatView = lazy(() => import("../chat/Chat"));
const SchedulerView = lazy(() => import("../scheduler/Scheduler"));
const DriveView = lazy(() => import("../drive/DriveBox"));
const NotesView = lazy(() => import("../notes/Notes"));
const TasksView = lazy(() => import("../tasks/Tasks"));
const AIChatView = lazy(() => import("../aichat/AIChat"));
const AboutView = lazy(() => import("../about/About"));

export const SPLIT_APPS = [
  { key: "home" as AppKey, label: "Home", path: "/", icon: "🏠", Comp: HomeView },
  { key: "emails" as AppKey, label: "Emails", path: "/emails", icon: "📧", Comp: EmailsView },
  { key: "chat" as AppKey, label: "Chat", path: "/chat", icon: "💬", Comp: ChatView },
  { key: "scheduler" as AppKey, label: "Scheduler", path: "/scheduler", icon: "📅", Comp: SchedulerView },
  { key: "drive" as AppKey, label: "Files", path: "/drive", icon: "📁", Comp: DriveView },
  { key: "notes" as AppKey, label: "Notes", path: "/notes", icon: "📝", Comp: NotesView },
  { key: "tasks" as AppKey, label: "Tasks", path: "/tasks", icon: "☑", Comp: TasksView },
  { key: "aichat" as AppKey, label: "AI Chat", path: "/aichat", icon: "✨", Comp: AIChatView },
  { key: "about" as AppKey, label: "About", path: "/about", icon: "ⓘ", Comp: AboutView },
];
