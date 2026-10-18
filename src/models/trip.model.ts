
export interface Trip {
  id: number;
  startDate: string;
  endDate: string;
  // Coupa's required "Business Purpose" for every line of this trip.
  purpose?: string;
  // Name for this trip's Coupa expense report.
  reportTitle?: string;
}
