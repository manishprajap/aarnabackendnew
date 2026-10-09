import { redirect } from 'next/navigation';

export default function LegacyAdminManagePage() {
  redirect('/admin/business-setup');
}
