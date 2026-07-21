import { lazy } from "react";

// "call" is absent by design: the split-pane picker treats Call as part of Chat.
// The /call route stays reachable via App.tsx for legacy bookmarks.
export type AppKey =
  | "home"
  | "emails"
  | "chat"
  | "scheduler"
  | "drive"
  | "notes"
  | "tasks"
  | "userstories"
  | "tickets"
  | "aichat"
  | "github"
  | "about"
  | "reminders"
  | "test_access";

const HomeView = lazy(() => import("../home/Home"));
const EmailsView = lazy(() => import("../emails/Emails"));
const ChatView = lazy(() => import("../chat/Chat"));
const SchedulerView = lazy(() => import("../scheduler/Scheduler"));
const DriveView = lazy(() => import("../drive/DriveBox"));
const NotesView = lazy(() => import("../notes/Notes"));
const TasksView = lazy(() => import("../tasks/Tasks"));
const UserStoriesView = lazy(() => import("../userstories/UserStories"));
const TicketsView = lazy(() => import("../tickets/Tickets"));
const AIChatView = lazy(() => import("../aichat/AIChat"));
const GitHubRepoView = lazy(() => import("../github/GitHubRepo"));
const AboutView = lazy(() => import("../about/About"));
const RemindersView = lazy(() => import("../reminders/Reminders"));

// Single source of truth for the split-pane apps and their top-level routes:
// App.tsx auto-renders a route per entry, so a new sidebar app needs only one
// entry here and no parallel edit there.
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
    key: "userstories",
    label: "User Stories",
    path: "/user-stories",
    icon: "📖",
    Comp: UserStoriesView,
  },
  {
    key: "tickets",
    label: "Tickets",
    path: "/tickets",
    icon: "🎫",
    Comp: TicketsView,
  },
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
  {
    key: "reminders",
    label: "Reminders",
    path: "/reminders",
    icon: "⏰",
    // App.tsx already declares /reminders; opt out of the generated route so
    // it isn't defined twice. The entry exists so the Reminders bell can open
    // into the focused split pane (resolved via SPLIT_APPS like any app).
    autoRoute: false,
    Comp: RemindersView,
  },
];
