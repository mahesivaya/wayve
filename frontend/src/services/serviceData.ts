export type ServiceSlug =
  | "mail"
  | "chat"
  | "meet"
  | "calendar"
  | "drive"
  | "notes"
  | "tasks"
  | "ai";

export type ServiceDetail = {
  slug: ServiceSlug;
  appPath: string;
  icon: string;
  accent: string;
  name: string;
  eyebrow: string;
  summary: string;
  description: string;
  features: string[];
  useCases: string[];
};

export const SERVICES: ServiceDetail[] = [
  {
    slug: "mail",
    appPath: "/emails",
    icon: "M",
    accent: "mail",
    name: "Wayve Mail",
    eyebrow: "Secure email",
    summary: "Encrypted email for private communication.",
    description:
      "Wayve Mail helps users send, receive, search, and manage email from a secure workspace. It is designed for daily inbox work with privacy-conscious handling of message content and attachments.",
    features: [
      "Send and receive email from one workspace",
      "Search messages quickly",
      "View attachments and related files",
      "Keep email connected with chat, files, and scheduling",
    ],
    useCases: [
      "Managing personal and organization inboxes",
      "Finding past conversations and attachments",
      "Coordinating work without leaving the app",
    ],
  },
  {
    slug: "chat",
    appPath: "/chat",
    icon: "C",
    accent: "chat",
    name: "Wayve Chat",
    eyebrow: "Team messaging",
    summary: "Direct messages and channels for team communication.",
    description:
      "Wayve Chat gives users a place for personal messages, public channels, private channels, invites, member roles, and admin-managed channel settings.",
    features: [
      "Direct personal conversations",
      "Public and private channels",
      "Admin controls for subject and members",
      "Join requests for private channels",
    ],
    useCases: [
      "Creating project channels",
      "Keeping team discussions organized",
      "Separating private team work from public updates",
    ],
  },
  {
    slug: "meet",
    appPath: "/call",
    icon: "V",
    accent: "meet",
    name: "Wayve Meet",
    eyebrow: "Private calling",
    summary: "Voice and video calls for fast conversations.",
    description:
      "Wayve Meet supports real-time calling so users can move from chat or scheduling into a live conversation when typing is not enough.",
    features: [
      "Real-time call experience",
      "Works from the main app layout",
      "Designed for quick team conversations",
      "Connected with the rest of the workspace",
    ],
    useCases: [
      "Running team check-ins",
      "Jumping from chat to a live discussion",
      "Hosting private project conversations",
    ],
  },
  {
    slug: "calendar",
    appPath: "/scheduler",
    icon: "31",
    accent: "calendar",
    name: "Wayve Calendar",
    eyebrow: "Scheduling",
    summary: "A calendar workspace for meetings and planning.",
    description:
      "Wayve Calendar helps users organize meetings, view schedules, and manage upcoming work from inside the same product suite.",
    features: [
      "Calendar-based schedule view",
      "Meeting and event planning",
      "Fast navigation between days and events",
      "Integrated with the workspace header",
    ],
    useCases: [
      "Planning daily meetings",
      "Tracking upcoming work",
      "Keeping communication and scheduling together",
    ],
  },
  {
    slug: "drive",
    appPath: "/drive",
    icon: "D",
    accent: "drive",
    name: "Wayve Drive",
    eyebrow: "Secure files",
    summary: "Store and manage files in one workspace.",
    description:
      "Wayve Drive provides a central place to upload, browse, and manage files so important documents are available beside mail, chat, notes, and meetings.",
    features: [
      "Upload and manage files",
      "Browse workspace documents",
      "Keep files close to team conversations",
      "Use one app instead of scattered tools",
    ],
    useCases: [
      "Organizing project files",
      "Keeping reference documents available",
      "Managing shared workspace assets",
    ],
  },
  {
    slug: "notes",
    appPath: "/notes",
    icon: "N",
    accent: "notes",
    name: "Wayve Notes",
    eyebrow: "Private notes",
    summary: "Write and store notes across your workspace.",
    description:
      "Wayve Notes gives users a simple writing area for ideas, meeting notes, planning, and private documentation.",
    features: [
      "Create and manage notes",
      "Capture ideas quickly",
      "Keep notes alongside files and messages",
      "Use for personal or team planning",
    ],
    useCases: [
      "Writing meeting summaries",
      "Collecting project ideas",
      "Keeping personal work notes organized",
    ],
  },
  {
    slug: "tasks",
    appPath: "/tasks",
    icon: "T",
    accent: "tasks",
    name: "Wayve Tasks",
    eyebrow: "Task management",
    summary: "Create and track work items with clear details.",
    description:
      "Wayve Tasks gives users a focused place to create task names, add descriptions, and keep lightweight work items near mail, chat, files, and notes.",
    features: [
      "Create tasks with a name and description",
      "Review all tasks in one workspace",
      "Search task names and details",
      "Keep task tracking beside communication tools",
    ],
    useCases: [
      "Tracking personal to-dos",
      "Capturing follow-ups from meetings",
      "Turning chat or email work into action items",
    ],
  },
  {
    slug: "ai",
    appPath: "/ai-chat",
    icon: "AI",
    accent: "ai",
    name: "Wayve AI",
    eyebrow: "AI assistant",
    summary: "Ask questions, draft ideas, and accelerate work.",
    description:
      "Wayve AI is an assistant experience for drafting, brainstorming, summarizing, and exploring ideas without leaving the workspace.",
    features: [
      "Chat with an AI assistant",
      "Draft and refine text",
      "Brainstorm ideas quickly",
      "Use AI beside your daily tools",
    ],
    useCases: [
      "Writing first drafts",
      "Generating planning ideas",
      "Getting help while working across apps",
    ],
  },
];

export const SERVICE_BY_SLUG = Object.fromEntries(
  SERVICES.map((service) => [service.slug, service])
) as Record<ServiceSlug, ServiceDetail>;
