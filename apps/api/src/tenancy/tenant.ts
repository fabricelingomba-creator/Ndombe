export interface Tenant {
  id: string;
  slug: string;
  name: string;
  status: 'active' | 'suspended';
  plan: 'standard' | 'premium';
  keycloakRealm: string;
  defaultLocale: string;
}
