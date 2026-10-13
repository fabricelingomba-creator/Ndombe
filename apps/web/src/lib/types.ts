export interface Branding {
  logoUrl: string | null;
  faviconUrl: string | null;
  primaryColor: string;
  secondaryColor: string;
  hero: Hero;
}

export interface Hero {
  title?: string;
  subtitle?: string;
  imageUrl?: string;
}

export interface Manifest {
  slug: string;
  name: string;
  locale: string;
  branding: Branding | null;
  features: string[];
  auth: { issuer: string };
}

export interface Announcement {
  id: string;
  title: string;
  body: string;
  visibility: 'public' | 'campus';
  publishedAt: string;
}

export interface Homepage {
  hero: Hero;
  faculties: { code: string; name: string }[];
  announcements: Announcement[];
}

export interface Me {
  id: string;
  email: string;
  fullName: string;
  roles: string[];
  permissions: string[];
}
