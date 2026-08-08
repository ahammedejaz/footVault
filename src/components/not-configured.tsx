/**
 * What a clone with no `.env.local` sees.
 *
 * This component is the second half of a promise `isSupabaseConfigured()` had
 * been making on its own since Phase 3. Its doc comment said the storefront
 * "degrades to a styled empty state rather than a stack trace", and that was
 * true of exactly one caller — the proxy, which returns early so middleware
 * does not throw. Every page then went on to call `SUPABASE_URL()`, which
 * throws, and the promise was kept only in the sense that an error boundary
 * eventually caught it.
 *
 * The difference matters to precisely one person: somebody who has just cloned
 * this repository. In production Next hides an error's message behind a digest,
 * which is correct — but it means the one situation where the message *is* the
 * whole value is the one where nobody can read it. So the check moved onto the
 * render path, in the root layout, where it costs one `process.env` read that
 * the bundler has already inlined.
 *
 * Deliberately styled with literal colours and no design tokens. Tokens live in
 * globals.css, globals.css is imported by the layout, and if the reason you are
 * seeing this page is that the build is in a bad state then a page that depends
 * on the stylesheet is a page that renders as unstyled text.
 */
export function NotConfigured({ missing }: { missing: string[] }) {
  return (
    <main
      style={{
        minHeight: "100dvh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "2rem 1.5rem",
        background: "#f7f5f2",
        color: "#0a1526",
        fontFamily:
          "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
      }}
    >
      <div style={{ maxWidth: "34rem" }}>
        <p
          style={{
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontSize: "0.75rem",
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            color: "#5d6470",
            margin: 0,
          }}
        >
          Foot Vault
        </p>
        <h1
          style={{
            fontSize: "1.75rem",
            fontWeight: 800,
            letterSpacing: "-0.02em",
            margin: "0.5rem 0 0",
          }}
        >
          This copy is not configured yet
        </h1>
        <p style={{ margin: "0.75rem 0 0", lineHeight: 1.6 }}>
          The site is running, but it has no database to read. That is the
          expected state of a fresh clone — nothing is broken.
        </p>
        <p style={{ margin: "1rem 0 0.5rem", lineHeight: 1.6 }}>
          {missing.length === 1 ? (
            <>
              One environment variable is missing:{" "}
              <code style={CODE}>{missing[0]}</code>
            </>
          ) : (
            <>These environment variables are missing:</>
          )}
        </p>
        {missing.length > 1 ? (
          <ul
            style={{
              margin: "0 0 0.5rem",
              paddingLeft: "1.25rem",
              lineHeight: 1.8,
            }}
          >
            {missing.map((name) => (
              <li key={name}>
                <code style={CODE}>{name}</code>
              </li>
            ))}
          </ul>
        ) : null}
        <p style={{ margin: "1rem 0 0", lineHeight: 1.6 }}>
          Copy <code style={CODE}>.env.example</code> to{" "}
          <code style={CODE}>.env.local</code>, fill in the values from your
          Supabase project, and restart the dev server. Every variable is
          documented in <code style={CODE}>README.md</code>.
        </p>
      </div>
    </main>
  );
}

const CODE: React.CSSProperties = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: "0.875em",
  background: "#e8e4de",
  padding: "0.1em 0.35em",
  borderRadius: "0.25rem",
};
