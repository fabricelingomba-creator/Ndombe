/**
 * Version web (aperçu de développement uniquement) : le navigateur n'a pas de
 * trousseau, la session vit le temps de l'onglet.
 */
export const secure = {
  get: async (key: string) => sessionStorage.getItem(`elongo.${key}`),
  set: async (key: string, value: string) => sessionStorage.setItem(`elongo.${key}`, value),
  delete: async (key: string) => sessionStorage.removeItem(`elongo.${key}`),
};
