import { render } from "preact";
import { useState } from "preact/hooks";
import { Login } from "./pages/Login";
import { Clients } from "./pages/Clients";
import "./styles.css";

// No router library — scope is two views (login, client list) gated purely by auth state, so a
// single boolean is simpler than wiring up client-side routes for pages that don't have their
// own meaningfully distinct URLs yet.
const App = () => {
  const [loggedIn, setLoggedIn] = useState(false);

  return loggedIn ? (
    <Clients onUnauthorized={() => setLoggedIn(false)} />
  ) : (
    <Login onLoggedIn={() => setLoggedIn(true)} />
  );
};

render(<App />, document.getElementById("app")!);
