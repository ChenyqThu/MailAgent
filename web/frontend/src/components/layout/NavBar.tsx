import { NavLink } from "react-router";
import { clsx } from "clsx";

const LINKS = [
  { to: "/", label: "Dashboard" },
  { to: "/inbox", label: "工作台" },
] as const;

export function NavBar() {
  return (
    <header className="h-11 flex items-center px-4 border-b border-border flex-shrink-0 gap-6">
      <span className="text-sm font-semibold text-gray-300 mr-2">MailAgent</span>
      <nav className="flex gap-1">
        {LINKS.map((link) => (
          <NavLink
            key={link.to}
            to={link.to}
            end={link.to === "/"}
            className={({ isActive }) =>
              clsx(
                "px-3 py-1 rounded text-xs transition-colors",
                isActive
                  ? "bg-accent-dim text-accent font-medium"
                  : "text-gray-500 hover:text-gray-300"
              )
            }
          >
            {link.label}
          </NavLink>
        ))}
      </nav>
    </header>
  );
}
