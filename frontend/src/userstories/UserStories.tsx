import Tasks, { type TasksConfig } from "../tasks/Tasks";
import {
  getUserStories,
  createUserStoryApi,
  updateUserStoryApi,
  deleteUserStoryApi,
} from "../api/userStories";

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
  },
  features: { attachments: false, statusSummary: true },
  storageKey: "userstories",
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
