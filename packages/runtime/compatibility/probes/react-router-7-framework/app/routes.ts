import { type RouteConfig, index, route } from '@react-router/dev/routes';

export default [index('routes/home.tsx'), route('contacts/:id', 'routes/contact.tsx')] satisfies RouteConfig;
