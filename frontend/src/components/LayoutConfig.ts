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
  | "github"
  | "about"
  | "test_access";

const HomeView = lazy(() => import("../home/Home"));
const EmailsView = lazy(() => import("../emails/Emails"));
const ChatView = lazy(() => import("../chat/Chat"));
const SchedulerView = lazy(() => import("../scheduler/Scheduler"));
const DriveView = lazy(() => import("../drive/DriveBox"));
const NotesView = lazy(() => import("../notes/Notes"));
const TasksView = lazy(() => import("../tasks/Tasks"));
const AIChatView = lazy(() => import("../aichat/AIChat"));
const GitHubRepoView = lazy(() => import("../github/GitHubRepo"));
const AboutView = lazy(() => import("../about/About"));

// Single source of truth for the sidebar split-pane apps AND their top-level
// routes. App.tsx auto-renders a `<Route path element>` for every entry whose
// `autoRoute` isn't false; entries flagged `autoRoute: false` keep a
// hand-written guarded/redirecting route in App.tsx (but still show in the
// sidebar here). Add a new sidebar app by adding ONE entry below — no parallel
// edit in App.tsx.
export type SplitApp = {
  key: AppKey;
  label: string;
  path: string;
  icon: string;
  Comp: ReturnType<typeof lazy>;
  /** false → App.tsx owns the route (guard/redirect); default true. */
  autoRoute?: boolean;
};

export const SPLIT_APPS: SplitApp[] = [
  {
    key: "home",
    label: "Home",
    path: "/",
    icon: "🏠",
    Comp: HomeView,
    autoRoute: false,
  },
  {
    key: "emails",
    label: "Emails",
    path: "/emails",
    icon: "📧",
    Comp: EmailsView,
  },
  { key: "chat", label: "Chat", path: "/chat", icon: "💬", Comp: ChatView },
  {
    key: "scheduler",
    label: "Scheduler",
    path: "/scheduler",
    icon: "📅",
    Comp: SchedulerView,
  },
  { key: "drive", label: "Drive", path: "/drive", icon: "📁", Comp: DriveView },
  { key: "notes", label: "Notes", path: "/notes", icon: "📝", Comp: NotesView },
  { key: "tasks", label: "Tasks", path: "/tasks", icon: "☑", Comp: TasksView },
  {
    key: "aichat",
    label: "AI Chat",
    path: "/ai-chat",
    icon: "✨",
    Comp: AIChatView,
  },
  {
    key: "github",
    label: "GitHub",
    path: "/github",
    icon: "GH",
    Comp: GitHubRepoView,
    autoRoute: false,
  },
  { key: "about", label: "About", path: "/about", icon: "ⓘ", Comp: AboutView },
];
