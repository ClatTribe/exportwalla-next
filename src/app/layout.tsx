// Every public page is plain server-rendered HTML from a route handler (src/app/[[...path]]/route.ts), so this layout
// only wraps Next's own fallback screens.
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en-IN">
      <body>{children}</body>
    </html>
  );
}
