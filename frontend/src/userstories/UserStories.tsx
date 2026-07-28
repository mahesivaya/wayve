import Tasks, { type TasksConfig } from "../tasks/Tasks";
import {
  getUserStories,
  createUserStoryApi,
  updateUserStoryApi,
  deleteUserStoryApi,
} from "../api/userStories";
import { storyAiFix } from "../api/aiFix";

// The Workspace "User Stories" board is the Tasks board with an org-shared data
// source and story-flavoured labels. Statuses, projects and assignable users are
// the same endpoints as Tasks (see api/userStories.ts); attachments are disabled
// because they are task-only server-side.
const USER_STORIES_CONFIG: TasksConfig = {
  api: {
    list: getUserStories,
    create: createUserStoryApi,
    update: updateUserStoryApi,
    remove: deleteUserStoryApi,
    aiFixPanel: storyAiFix,
  },
  // Attachments are task-only server-side. The Design (Figma) section is off
  // here by choice — stories carry the narrative, and the design lives on the
  // ticket that implements it; the story_figma_links table and its endpoints
  // stay, so turning this back on restores any links already attached.
  features: {
    attachments: false,
    statusSummary: true,
    figmaLinks: false,
    // Stories open up to the AI fixer only at P5 (Lowest) — the least risky
    // end of the backlog. Tickets start one step higher, at P4.
    aiFixMinPriority: 5,
  },
  storageKey: "userstories",
  // Name click opens the story in a right-side drawer; Edit opens the full page.
  detailDrawer: true,
  detailPath: (id) => `/user-stories/${id}`,
  labels: {
    title: "User Stories",
    subtitle: "A shared backlog of user stories for your workspace.",
    singular: "Story",
    lowerSingular: "story",
    lowerPlural: "user stories",
    createButton: "+ Create story",
    createTitle: "Create Story",
    editTitle: "Edit Story",
    namePlaceholder: "Story title",
    numberBadgeTooltip: "Story key",
    filtersTooltip: "Filter user stories",
    filtersAria: "User story filters",
  },
};

export default function UserStories() {
  return <Tasks config={USER_STORIES_CONFIG} />;
}
