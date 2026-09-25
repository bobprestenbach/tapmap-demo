import type { Metadata } from "next";
import AdminApp from "./AdminApp";
import "./admin.css";

export const metadata: Metadata = {
  title: "TapMap Admin",
  robots: { index: false, follow: false },
};

export default function AdminPage() {
  return <AdminApp />;
}
