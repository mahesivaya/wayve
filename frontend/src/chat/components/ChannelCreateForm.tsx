type Props = {
  channelName: string;
  error: string;
  onChannelNameChange: (value: string) => void;
  onCancel: () => void;
  onCreate: () => void;
};

export default function ChannelCreateForm({
  channelName,
  error,
  onChannelNameChange,
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
