import { createBrowserRouter } from "react-router";
import App from "./App";
import DashboardPage from "./pages/DashboardPage";
import InboxPage from "./pages/InboxPage";

export const router = createBrowserRouter([
  {
    path: "/",
    element: <App />,
    children: [
      { index: true, element: <DashboardPage /> },
      { path: "inbox", element: <InboxPage /> },
    ],
  },
]);
