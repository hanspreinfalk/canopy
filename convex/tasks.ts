//
//  tasks.ts
//  canopy
//
//  Created by Hans Preinfalk on 5/3/26.
//

import { query } from "./_generated/server";

export const get = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("tasks").collect();
  },
});
