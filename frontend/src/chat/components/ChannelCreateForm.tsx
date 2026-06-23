import type { ChannelVisibility } from "../types";

type Props = {
  channelName: string;
  visibility: ChannelVisibility;
  error: string;
  onChannelNameChange: (value: string) => void;
  onVisibilityChange: (value: ChannelVisibility) => void;
  onCancel: () => void;
  onCreate: () => void;
};

export default function ChannelCreateForm({
  channelName,
  visibility,
  error,
  onChannelNameChange,
  onVisibilityChange,
  onCancel,
  onCreate,
}: Props) {
  return (
    <div className="channel-form">
      <label className="channel-field">
        <span>Channel name</span>
        <input
          value={channelName}
          onChange={(e) => onChannelNameChange(e.target.value)}
          placeholder="project-updates"
        />
      </label>

      <label className="channel-field">
        <span>Visibility</span>
        <select
          value={visibility}
          onChange={(e) =>
            onVisibilityChange(e.target.value as ChannelVisibility)
          }
          aria-label="Channel visibility"
        >
          <option value="public">Public group</option>
          <option value="private">Private group</option>
        </select>
      </label>

      {error && <div className="channel-error">{error}</div>}

      <div className="channel-form-actions">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="primary" onClick={onCreate}>
          Create
        </button>
      </div>
    </div>
  );
}
