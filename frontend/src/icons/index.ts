// Central icon module — the single place every component imports icons from.
//
// Standard icons come from lucide-react (MIT), re-exported here under
// app-semantic names so the underlying set can be swapped in ONE file without
// touching call sites. Bespoke marks lucide can't provide (the Git logo, the
// two-tone brand bug glyph, the stateful CI status) live as local components.
//
// All icons render with `currentColor` + a `size` prop, so they inherit the
// sidebar / button color and theme automatically.

export {
  // Sidebar / feature sections
  House as HomeIcon,
  Mail as EmailsIcon,
  MessageCircle as ChatIcon,
  Calendar as SchedulerIcon,
  Folder as DriveIcon,
  NotebookPen as NotesIcon,
  SquareCheck as TasksIcon,
  Sparkles as AIChatIcon,
  Info as AboutIcon,
  Unlock as TestAccessIcon,
  UserRoundCheck as AccessRequestsIcon,
  FileText as DocumentsIcon,
  // Platform / admin sections
  CreditCard as BillingIcon,
  Settings as DeveloperIcon,
  BarChart3 as AnalyticsIcon,
  Globe as DomainsIcon,
  Key as SecretsIcon,
  ScrollText as LogsIcon,
  Users as VisitorsIcon,
  UsersRound as TeamsIcon,
  User as UserLogsIcon,
  Lock as AuditIcon,
  LineChart as TracingIcon,
  DollarSign as PricingIcon,
  Headphones as SupportIcon,
  ShieldCheck as SecurityIcon,
  // Developers section
  BookOpen as DocsIcon,
  BookMarked as ApiRefIcon,
  Package as LibrariesIcon,
  Wrench as SdkIcon,
  KeyRound as ApiKeysIcon,
  // Generic / actions
  Bell as BellIcon,
  AlarmClock as ReminderIcon,
  Reply as ReplyIcon,
  Forward as ForwardIcon,
  Trash2 as TrashIcon,
  List as ListViewIcon,
  LayoutGrid as GridViewIcon,
  Save as SaveIcon,
  Dices as DiceIcon,
  Phone as PhoneIcon,
  Video as VideoIcon,
  Search as SearchIcon,
  ChevronRight as ChevronIcon,
  Plus as PlusIcon,
  // Addable "fake" personal apps (placeholder catalog)
  Palette as CanvasIcon,
  FileSpreadsheet as FormsIcon,
  Workflow as AutomationsIcon,
  PenTool as WhiteboardIcon,
  PieChart as InsightsIcon,
  Bot as AssistantIcon,
  Settings as SettingsIcon,
  File as FileIcon,
  Folder as FolderIcon,
  // Sidebar collapsible-section headers
  Briefcase as WorkspaceIcon,
  LayoutDashboard as PlatformIcon,
  Code2 as DevelopersIcon,
  Building2 as OrganizationIcon,
} from "lucide-react";

// Org/business dashboard tiles
export {
  Settings as SettingsTileIcon,
  Users as MembersIcon,
  // Generic single-person silhouette — the default avatar when a user has no
  // uploaded photo (never a name-derived initial).
  UserRound as PersonIcon,
  ShieldCheck as SecurityTileIcon,
  Headphones as SupportTileIcon,
  Fingerprint as SsoIcon,
  Webhook as WebhooksIcon,
  IdCard as ScimIcon,
  Code2 as DeveloperTileIcon,
  FolderGit2 as ProjectsTileIcon,
} from "lucide-react";

export { default as GitLogoIcon } from "./GitLogoIcon";
export { default as BugReportIcon } from "./BugReportIcon";
