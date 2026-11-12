import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  Link,
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useParams,
} from "react-router-dom";
import PathPane from "../components/tabs/PathPane";
import { PaneRoutesContext } from "../components/tabs/paneContexts";

function Ticket() {
  const { id } = useParams();
  return (
    <div>
      <p>ticket {id}</p>
      <Link to="/tickets">Back to board</Link>
    </div>
  );
}

function MainLocation() {
  return <p data-testid="main">{useLocation().pathname}</p>;
}

const renderRoutes = (location?: string) => (
  <Routes location={location}>
    <Route path="/tickets/:id" element={<Ticket />} />
    <Route path="/tickets" element={<p>board</p>} />
    <Route path="*" element={<MainLocation />} />
  </Routes>
);

describe("PathPane", () => {
  it("renders the tab's exact URL and navigates only itself", () => {
    const onNavigate = vi.fn();
    render(
      <MemoryRouter initialEntries={["/chat"]}>
        <PaneRoutesContext.Provider value={renderRoutes}>
          {renderRoutes()}
          <PathPane path="/tickets/6" onNavigate={onNavigate} />
        </PaneRoutesContext.Provider>
      </MemoryRouter>
    );

    expect(screen.getByText("ticket 6")).toBeTruthy();
    fireEvent.click(screen.getByText("Back to board"));
    expect(onNavigate).toHaveBeenCalledWith("/tickets");
    // The main view did not move.
    expect(screen.getByTestId("main").textContent).toBe("/chat");
  });
});
