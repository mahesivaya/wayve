import { useNavigate } from "react-router-dom";
import "../home/home.css";
import { BRAND_NAME } from "../config/brand";

export default function Organization() {
  const navigate = useNavigate();

  return (
    <div className="home organization-welcome">
      <h1>Hello {BRAND_NAME}</h1>
      <div className="auth-buttons">
        <button onClick={() => navigate("/")}>Home</button>
      </div>
    </div>
  );
}
