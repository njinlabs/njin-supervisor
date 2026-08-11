import { useState } from "preact/hooks";
import { login } from "../api";

export const Login = ({ onLoggedIn }: { onLoggedIn: () => void }) => {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: SubmitEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const ok = await login(email, password);
    setSubmitting(false);
    if (ok) onLoggedIn();
    else setError("Invalid email or password.");
  };

  return (
    <div class="login-screen">
      <form class="login-card" onSubmit={handleSubmit}>
        <h1>njin-supervisor</h1>
        <p class="subtitle">Sign in to the dashboard</p>

        {error && <div class="alert" role="alert">{error}</div>}

        <div class="field">
          <label for="email">Email</label>
          <input
            id="email"
            type="email"
            autocomplete="username"
            value={email}
            onInput={(e) => setEmail((e.target as HTMLInputElement).value)}
            required
          />
        </div>
        <div class="field">
          <label for="password">Password</label>
          <input
            id="password"
            type="password"
            autocomplete="current-password"
            value={password}
            onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
            required
          />
        </div>

        <button class="btn btn-primary" type="submit" disabled={submitting}>
          {submitting ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
};
