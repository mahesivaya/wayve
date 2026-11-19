import type { ChannelVisibility } from "../types";

type Props = {
  channelName: string;
  visibility: ChannelVisibility;
  // False in organizations and on the platform, where every channel is public.
  canChooseVisibility: boolean;
  error: string;
  onChannelNameChange: (value: string) => void;
  onVisibilityChange: (value: ChannelVisibility) => void;
  onCancel: () => void;
  onCreate: () => void;
};

const VISIBILITY_CHOICES: {
  value: ChannelVisibility;
  label: string;
  hint: string;
}[] = [
  {
    value: "private",
    label: "Private",
    hint: "Only people you add or invite can join.",
  },
  {
    value: "public",
    label: "Public",
    hint: "Anyone with a personal account can join without asking.",
  },
];

export default function ChannelCreateForm({
  channelName,
  visibility,
  canChooseVisibility,
  error,
  onChannelNameChange,
  onVisibilityChange,
  onCancel,
  onCreate,
}: Props) {
  return (
    // A form, so Enter in the name field creates the channel.
    <form
      className="channel-form"
      onSubmit={(e) => {
        e.preventDefault();
        onCreate();
      }}
    >
      <label className="channel-field">
        <span>Channel name</span>
        <input
          value={channelName}
          onChange={(e) => onChannelNameChange(e.target.value)}
          placeholder="e.g. project-updates"
          autoFocus
        />
      </label>

      {canChooseVisibility && (
        // Radio buttons with what each choice means beside it, so who can get
        // into the channel is decided on purpose rather than left at a default.
        <fieldset className="channel-visibility">
          <legend>Who can join</legend>
          {VISIBILITY_CHOICES.map((choice) => (
            <label key={choice.value} className="channel-visibility-option">
              <input
                type="radio"
                name="channel-visibility"
                value={choice.value}
                checked={visibility === choice.value}
                onChange={() => onVisibilityChange(choice.value)}
              />
              <span>
                <strong>{choice.label}</strong>
                <small>{choice.hint}</small>
              </span>
            </label>
          ))}
        </fieldset>
      )}

      {error && <div className="channel-error">{error}</div>}

      <div className="channel-form-actions">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="primary">
          Create
        </button>
      </div>
    </form>
  );
}
