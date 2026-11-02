import { useLiveCount } from "../components/useLiveCount";
import { getUserStories, USER_STORIES_CHANGED_EVENT } from "../api/userStories";

// Reuses the list endpoint (no dedicated count route), counting the rows it
// already returns.
const fetchStoryCount = () =>
  getUserStories().then((stories) => stories.length);

// Number of user stories in the owner's backlog, for the Workspace sidebar
// badge. Refreshes on any story write in any open tab
// (USER_STORIES_CHANGED_EVENT), on focus/visibility, and on a short poll for
// changes made elsewhere — see useLiveCount.
export function useUserStoriesCount(enabled: boolean = true): number {
  return useLiveCount(fetchStoryCount, USER_STORIES_CHANGED_EVENT, enabled);
}
