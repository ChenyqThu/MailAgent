import { Outlet } from "react-router";
import { NavBar } from "@/components/layout/NavBar";
import { useSSE } from "@/hooks/useSSE";

export default function App() {
  useSSE();

  return (
    <div className="h-screen flex flex-col bg-bg-primary text-gray-100">
      <NavBar />
      <Outlet />
    </div>
  );
}
