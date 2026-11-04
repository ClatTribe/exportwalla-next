// Live numbers and the country strip for the home page. Prerendered at build: the database ships with the deploy.
import { handle } from "@/lib/server/http";
import { home } from "@/lib/server/public";

export const GET = () => handle(home);
