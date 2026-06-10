import { useAuth } from "../auth/useAuth";
import { useNavigate } from "react-router-dom";

export default function Header() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  return (
    <div>
      {user ? (
        <>
          <span>{user.email}</span>
          <button
            onClick={() => {
              logout();
              void navigate("/");
            }}
          >
            Logout
          </button>
        </>
      ) : (
        <button>Login</button>
      )}
    </div>
  );
}
