
export interface Trip {
  id: number;
  startDate: string;
  endDate: string;
  // Coupa's required "Business Purpose" for every line of this trip.
  purpose?: string;
  // Name for this trip's Coupa expense report.
  reportTitle?: string;
  // Project (CoupaProject.id) whose cost code this trip is charged to.
  projectId?: string;
  // WBS element for this trip, when it isn't the project's usual one.
  wbs?: string;
}
