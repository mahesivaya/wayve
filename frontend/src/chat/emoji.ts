// The emoji catalog behind the composer's picker. Hand-curated rather than a
// dependency: a full emoji package ships megabytes of variants and sprite sheets to
// solve a problem we don't have, while this costs a few KB. Emoji are plain Unicode,
// so one typed into a message rides inside the E2E envelope like any other text.

export type EmojiCategory = {
  id: string;
  /** Shown as the group heading in the picker. */
  label: string;
  emojis: Emoji[];
};

export type Emoji = {
  char: string;
  /** Used for the picker's search box and as the button's accessible name. */
  name: string;
  /** Extra search terms beyond the words already in `name`. */
  keywords?: string[];
};

export const EMOJI_CATEGORIES: EmojiCategory[] = [
  {
    id: "reactions",
    label: "Frequently used",
    emojis: [
      {
        char: "👍",
        name: "thumbs up",
        keywords: ["yes", "ok", "approve", "+1"],
      },
      { char: "👎", name: "thumbs down", keywords: ["no", "reject", "-1"] },
      {
        char: "✅",
        name: "check mark",
        keywords: ["done", "tick", "complete"],
      },
      { char: "❌", name: "cross mark", keywords: ["no", "wrong", "fail"] },
      {
        char: "🎉",
        name: "party popper",
        keywords: ["celebrate", "ship", "launch"],
      },
      { char: "🔥", name: "fire", keywords: ["hot", "lit", "great"] },
      {
        char: "🚀",
        name: "rocket",
        keywords: ["ship", "launch", "deploy", "fast"],
      },
      { char: "👀", name: "eyes", keywords: ["look", "watching", "review"] },
      {
        char: "🙏",
        name: "folded hands",
        keywords: ["please", "thanks", "pray"],
      },
      {
        char: "💯",
        name: "hundred points",
        keywords: ["100", "perfect", "agree"],
      },
      { char: "❤️", name: "red heart", keywords: ["love", "like"] },
      {
        char: "⚡",
        name: "high voltage",
        keywords: ["fast", "quick", "power"],
      },
    ],
  },
  {
    id: "smileys",
    label: "Smileys & people",
    emojis: [
      { char: "😀", name: "grinning face", keywords: ["happy", "smile"] },
      { char: "😃", name: "grinning face with big eyes", keywords: ["happy"] },
      {
        char: "😄",
        name: "grinning face with smiling eyes",
        keywords: ["happy"],
      },
      { char: "😁", name: "beaming face", keywords: ["happy", "grin"] },
      { char: "😆", name: "grinning squinting face", keywords: ["laugh"] },
      {
        char: "😅",
        name: "grinning face with sweat",
        keywords: ["relief", "phew"],
      },
      {
        char: "🤣",
        name: "rolling on the floor laughing",
        keywords: ["rofl", "lol"],
      },
      {
        char: "😂",
        name: "face with tears of joy",
        keywords: ["lol", "laugh", "cry"],
      },
      { char: "🙂", name: "slightly smiling face", keywords: ["smile"] },
      { char: "🙃", name: "upside down face", keywords: ["irony", "sarcasm"] },
      { char: "😉", name: "winking face", keywords: ["wink"] },
      {
        char: "😊",
        name: "smiling face with smiling eyes",
        keywords: ["blush"],
      },
      {
        char: "😇",
        name: "smiling face with halo",
        keywords: ["angel", "innocent"],
      },
      { char: "🥰", name: "smiling face with hearts", keywords: ["love"] },
      { char: "😍", name: "smiling face with heart eyes", keywords: ["love"] },
      { char: "🤩", name: "star struck", keywords: ["wow", "amazing"] },
      { char: "😘", name: "face blowing a kiss", keywords: ["kiss"] },
      { char: "😋", name: "face savoring food", keywords: ["yum", "tasty"] },
      { char: "😎", name: "smiling face with sunglasses", keywords: ["cool"] },
      { char: "🤓", name: "nerd face", keywords: ["geek", "smart"] },
      { char: "🧐", name: "face with monocle", keywords: ["inspect", "hmm"] },
      { char: "🤔", name: "thinking face", keywords: ["hmm", "consider"] },
      {
        char: "🤨",
        name: "face with raised eyebrow",
        keywords: ["skeptical", "doubt"],
      },
      { char: "😐", name: "neutral face", keywords: ["meh", "blank"] },
      { char: "😑", name: "expressionless face", keywords: ["blank"] },
      {
        char: "🙄",
        name: "face with rolling eyes",
        keywords: ["eyeroll", "whatever"],
      },
      {
        char: "😴",
        name: "sleeping face",
        keywords: ["sleep", "zzz", "tired"],
      },
      {
        char: "😭",
        name: "loudly crying face",
        keywords: ["sad", "cry", "sob"],
      },
      {
        char: "😱",
        name: "face screaming in fear",
        keywords: ["shock", "scared"],
      },
      {
        char: "😤",
        name: "face with steam from nose",
        keywords: ["frustrated", "angry"],
      },
      { char: "😡", name: "enraged face", keywords: ["angry", "mad"] },
      {
        char: "🤯",
        name: "exploding head",
        keywords: ["mind blown", "shock", "wow"],
      },
      { char: "🥳", name: "partying face", keywords: ["celebrate", "party"] },
      { char: "🫠", name: "melting face", keywords: ["hot", "overwhelmed"] },
      { char: "😬", name: "grimacing face", keywords: ["awkward", "yikes"] },
      { char: "🥲", name: "smiling face with tear", keywords: ["bittersweet"] },
      { char: "😢", name: "crying face", keywords: ["sad", "tear"] },
      {
        char: "😳",
        name: "flushed face",
        keywords: ["embarrassed", "surprise"],
      },
      { char: "🤡", name: "clown face", keywords: ["joke", "silly"] },
      { char: "💀", name: "skull", keywords: ["dead", "dying", "lol"] },
    ],
  },
  {
    id: "gestures",
    label: "Gestures & body",
    emojis: [
      { char: "👋", name: "waving hand", keywords: ["hi", "hello", "bye"] },
      { char: "🤝", name: "handshake", keywords: ["deal", "agree", "partner"] },
      {
        char: "👏",
        name: "clapping hands",
        keywords: ["applause", "bravo", "well done"],
      },
      {
        char: "🙌",
        name: "raising hands",
        keywords: ["celebrate", "hooray", "praise"],
      },
      { char: "🤞", name: "crossed fingers", keywords: ["hope", "luck"] },
      { char: "✌️", name: "victory hand", keywords: ["peace", "two"] },
      { char: "🤟", name: "love you gesture", keywords: ["rock"] },
      { char: "👌", name: "OK hand", keywords: ["ok", "perfect", "good"] },
      { char: "🤌", name: "pinched fingers", keywords: ["chef", "italian"] },
      {
        char: "💪",
        name: "flexed biceps",
        keywords: ["strong", "muscle", "power"],
      },
      {
        char: "🫡",
        name: "saluting face",
        keywords: ["yes sir", "on it", "respect"],
      },
      {
        char: "🤷",
        name: "person shrugging",
        keywords: ["shrug", "idk", "dunno"],
      },
      {
        char: "🤦",
        name: "person facepalming",
        keywords: ["facepalm", "oops"],
      },
      { char: "☝️", name: "index pointing up", keywords: ["one", "attention"] },
      { char: "👉", name: "index pointing right", keywords: ["this", "point"] },
      { char: "🫶", name: "heart hands", keywords: ["love", "thanks"] },
    ],
  },
  {
    id: "work",
    label: "Work & objects",
    emojis: [
      { char: "💻", name: "laptop", keywords: ["computer", "code", "work"] },
      { char: "🖥️", name: "desktop computer", keywords: ["monitor", "screen"] },
      { char: "⌨️", name: "keyboard", keywords: ["type"] },
      { char: "🐛", name: "bug", keywords: ["defect", "issue", "error"] },
      { char: "🔧", name: "wrench", keywords: ["fix", "tool", "repair"] },
      { char: "🔨", name: "hammer", keywords: ["build", "tool"] },
      {
        char: "🛠️",
        name: "hammer and wrench",
        keywords: ["tools", "build", "fix"],
      },
      { char: "⚙️", name: "gear", keywords: ["settings", "config", "cog"] },
      { char: "📝", name: "memo", keywords: ["note", "write", "edit"] },
      { char: "📌", name: "pushpin", keywords: ["pin", "important"] },
      {
        char: "📅",
        name: "calendar",
        keywords: ["date", "schedule", "meeting"],
      },
      {
        char: "⏰",
        name: "alarm clock",
        keywords: ["time", "reminder", "deadline"],
      },
      {
        char: "📈",
        name: "chart increasing",
        keywords: ["growth", "up", "metrics"],
      },
      {
        char: "📉",
        name: "chart decreasing",
        keywords: ["down", "drop", "loss"],
      },
      { char: "📊", name: "bar chart", keywords: ["metrics", "data", "stats"] },
      { char: "🔗", name: "link", keywords: ["url", "chain"] },
      { char: "📎", name: "paperclip", keywords: ["attach", "file"] },
      {
        char: "🔒",
        name: "locked",
        keywords: ["secure", "private", "encrypt"],
      },
      { char: "🔑", name: "key", keywords: ["password", "secret", "access"] },
      { char: "💡", name: "light bulb", keywords: ["idea", "suggestion"] },
      { char: "📦", name: "package", keywords: ["box", "release", "ship"] },
      { char: "🧪", name: "test tube", keywords: ["test", "experiment"] },
      {
        char: "🚨",
        name: "police car light",
        keywords: ["alert", "urgent", "incident"],
      },
      { char: "☕", name: "hot beverage", keywords: ["coffee", "break"] },
      { char: "🍕", name: "pizza", keywords: ["food", "lunch"] },
      { char: "🎯", name: "bullseye", keywords: ["target", "goal", "focus"] },
      { char: "🏆", name: "trophy", keywords: ["win", "award", "champion"] },
      { char: "⭐", name: "star", keywords: ["favorite", "rating"] },
      { char: "✨", name: "sparkles", keywords: ["new", "shiny", "magic"] },
      { char: "🌱", name: "seedling", keywords: ["growth", "new", "start"] },
    ],
  },
  {
    id: "symbols",
    label: "Symbols",
    emojis: [
      { char: "💚", name: "green heart", keywords: ["love", "like"] },
      { char: "💙", name: "blue heart", keywords: ["love", "like"] },
      { char: "💜", name: "purple heart", keywords: ["love", "like"] },
      { char: "🧡", name: "orange heart", keywords: ["love", "like"] },
      { char: "💔", name: "broken heart", keywords: ["sad", "breakup"] },
      {
        char: "⚠️",
        name: "warning",
        keywords: ["caution", "alert", "careful"],
      },
      {
        char: "❓",
        name: "question mark",
        keywords: ["question", "ask", "help"],
      },
      {
        char: "❗",
        name: "exclamation mark",
        keywords: ["important", "urgent"],
      },
      { char: "➕", name: "plus", keywords: ["add", "more"] },
      { char: "➖", name: "minus", keywords: ["remove", "less"] },
      { char: "🔁", name: "repeat", keywords: ["loop", "retry", "again"] },
      {
        char: "⏳",
        name: "hourglass",
        keywords: ["wait", "pending", "loading"],
      },
      { char: "🆗", name: "OK button", keywords: ["ok", "fine"] },
      { char: "🆕", name: "NEW button", keywords: ["new"] },
      { char: "🚫", name: "prohibited", keywords: ["no", "blocked", "banned"] },
      {
        char: "💬",
        name: "speech balloon",
        keywords: ["chat", "comment", "talk"],
      },
    ],
  },
];

export const ALL_EMOJIS: Emoji[] = EMOJI_CATEGORIES.flatMap((c) => c.emojis);

// Matches names and keywords, so "ship" finds 🚀 and 📦 even though neither is named
// that. A blank query returns nothing: the caller shows the categorized list instead.
export function searchEmojis(query: string): Emoji[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return ALL_EMOJIS.filter(
    (e) => e.name.includes(q) || (e.keywords ?? []).some((k) => k.includes(q))
  );
}
