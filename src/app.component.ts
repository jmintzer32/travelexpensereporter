
import { ChangeDetectionStrategy, Component, inject, signal, PLATFORM_ID } from '@angular/core';
import { CommonModule, isPlatformBrowser } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { GeminiService } from './services/gemini.service';
import { Expense } from './models/expense.model';
import { Trip } from './models/trip.model';
import { TripReport } from './models/trip-report.model';
import { MatIconModule } from '@angular/material/icon';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

interface UploadedFile {
  name: string;
  content: string;
}

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  imports: [CommonModule, FormsModule, MatIconModule],
})
export class AppComponent {
  private readonly geminiService = inject(GeminiService);
  private readonly platformId = inject(PLATFORM_ID);
  private pdfjsLib: any;
  private nextTripId = 1;

  uploadedFiles = signal<UploadedFile[]>([]);
  trips = signal<Trip[]>([]);
  reports = signal<TripReport[] | null>(null);
  isLoading = signal<boolean>(false);
  errorMessage = signal<string | null>(null);
  errorDetails = signal<string | null>(null);
  showErrorDetails = signal<boolean>(false);

  constructor() {
    try {
      if (isPlatformBrowser(this.platformId)) {
        this.initPdfJs();
      }
      this.addTrip();
    } catch (e) {
      this.handleError('Failed to initialize the application. Please refresh the page.', e);
    }
  }

  private handleError(userMessage: string, error: any): void {
    console.error(userMessage, error);
    this.errorMessage.set(userMessage);
    
    let details = '';
    if (error instanceof Error) {
        details = `${error.name}: ${error.message}\n\nStack:\n${error.stack}`;
    } else if (typeof error === 'object') {
        try {
            details = JSON.stringify(error, null, 2);
        } catch (e) {
            details = String(error);
        }
    } else {
        details = String(error);
    }
    this.errorDetails.set(details);
  }

  private loadPdfLib(): Promise<any> {
    return new Promise((resolve, reject) => {
      const win = window as any;
      if (win.pdfjsLib) {
        resolve(win.pdfjsLib);
        return;
      }

      const script = document.createElement('script');
      script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
      script.onload = () => {
        if (win.pdfjsLib) {
          win.pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js`;
          this.pdfjsLib = win.pdfjsLib;
          resolve(win.pdfjsLib);
        } else {
          reject(new Error('PDF.js loaded but pdfjsLib is undefined'));
        }
      };
      script.onerror = () => reject(new Error('Failed to load PDF.js script'));
      document.head.appendChild(script);
    });
  }

  private async initPdfJs() {
    try {
        await this.loadPdfLib();
    } catch (e) {
        console.warn('Pre-loading PDF lib failed, will retry on demand', e);
    }
  }

  private formatDateForInput(date: Date): string {
    return date.toISOString().split('T')[0];
  }

  addTrip(): void {
    const today = new Date();
    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(today.getDate() - 7);
    
    const newTrip: Trip = {
      id: this.nextTripId++,
      startDate: this.formatDateForInput(oneWeekAgo),
      endDate: this.formatDateForInput(today),
    };
    this.trips.update(currentTrips => [...currentTrips, newTrip]);
  }

  removeTrip(idToRemove: number): void {
    this.trips.update(currentTrips => currentTrips.filter(trip => trip.id !== idToRemove));
  }

  updateTripDate(id: number, field: 'startDate' | 'endDate', value: string): void {
    this.trips.update(currentTrips => 
      currentTrips.map(trip => 
        trip.id === id ? { ...trip, [field]: value } : trip
      )
    );
  }

  removeFile(fileNameToRemove: string): void {
    this.uploadedFiles.update(currentFiles =>
      currentFiles.filter(file => file.name !== fileNameToRemove)
    );
    if (this.uploadedFiles().length === 0) {
      this.reports.set(null);
    }
  }

  async onFileChange(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    if (!input.files?.length) {
      return;
    }

    const newFiles = Array.from(input.files);
    const existingFileNames = new Set(this.uploadedFiles().map(f => f.name));
    const uniqueNewFiles = newFiles.filter(file => !existingFileNames.has(file.name));

    if (uniqueNewFiles.length < newFiles.length) {
        // Optionally inform the user about duplicates, for now we just ignore them.
    }
    
    if (uniqueNewFiles.length === 0) {
      input.value = '';
      return;
    }
    
    this.errorMessage.set(null);
    this.errorDetails.set(null);
    this.reports.set(null);

    try {
        const fileReadPromises = uniqueNewFiles.map(file => {
            return new Promise<UploadedFile>((resolve, reject) => {
                const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
                
                if (isPdf) {
                    const reader = new FileReader();
                    reader.onload = async (e) => {
                        try {
                            const typedArray = new Uint8Array(e.target!.result as ArrayBuffer);
                            const win = window as any;
                            let pdfLib = win.pdfjsLib || this.pdfjsLib;
                            
                            if (!pdfLib) {
                                try {
                                    pdfLib = await this.loadPdfLib();
                                } catch (e) {
                                    throw new Error('PDF library could not be loaded. Please check your internet connection or use a CSV file.');
                                }
                            }
                            
                            // Ensure worker is set
                            if (!pdfLib.GlobalWorkerOptions.workerSrc) {
                                pdfLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js`;
                            }

                            const loadingTask = pdfLib.getDocument({ data: typedArray });
                            const pdf = await loadingTask.promise;
                            
                            let textContent = '';
                            for (let i = 1; i <= pdf.numPages; i++) {
                                const page = await pdf.getPage(i);
                                const text = await page.getTextContent();
                                textContent += text.items.map((s: any) => s.str).join(' ');
                                textContent += '\n\n';
                            }
                            resolve({ name: file.name, content: textContent });
                        } catch (pdfError: any) {
                            console.error('PDF Parsing Error:', pdfError);
                            reject(pdfError);
                        }
                    };
                    reader.onerror = () => reject(new Error(`Error reading PDF file: ${file.name}`));
                    reader.readAsArrayBuffer(file);
                } else {
                    const reader = new FileReader();
                    reader.onload = (e) => resolve({ name: file.name, content: e.target?.result as string });
                    reader.onerror = () => reject(new Error(`Error reading file: ${file.name}`));
                    reader.readAsText(file);
                }
            });
        });

        const newUploadedFiles = await Promise.all(fileReadPromises);
        this.uploadedFiles.update(current => [...current, ...newUploadedFiles]);
    } catch (error) {
        this.handleError('An unexpected error occurred while reading files.', error);
    } finally {
        input.value = '';
    }
  }

  isFormValid(): boolean {
    if (this.uploadedFiles().length === 0 || this.trips().length === 0) {
        return false;
    }
    return this.trips().every(trip => trip.startDate && trip.endDate && trip.startDate <= trip.endDate);
  }

  async generateReport(): Promise<void> {
    if (!this.isFormValid()) {
        if (this.uploadedFiles().length === 0) {
            this.errorMessage.set('Please upload at least one credit card statement file.');
        } else if (this.trips().length === 0) {
            this.errorMessage.set('Please define at least one trip.');
        } else {
            this.errorMessage.set('One or more trips has an invalid date range. Please ensure start dates are before or the same as end dates.');
        }
        return;
    }
    
    this.isLoading.set(true);
    this.reports.set(null);
    this.errorMessage.set(null);
    this.errorDetails.set(null);

    const statementContent = this.uploadedFiles()
      .map(f => f.content)
      .join('\n\n--- End of File ---\n\n');

    try {
      const reportPromises = this.trips().map(async (trip) => {
        const expenses = await this.geminiService.generateExpenseReport(
          statementContent,
          trip.startDate,
          trip.endDate
        );
        const total = expenses.reduce((acc, expense) => acc + expense.amount, 0);
        const reportTrip = { startDate: trip.startDate, endDate: trip.endDate };
        return { trip: reportTrip, expenses, total };
      });
      
      const results = await Promise.all(reportPromises);
      this.reports.set(results);
    } catch (error) {
      this.handleError('Failed to generate one or more expense reports. The AI model might be unable to process this file format. Please try a standard CSV or a text-selectable PDF format.', error);
    } finally {
      this.isLoading.set(false);
    }
  }

  getCategoryClass(category: string): string {
    switch (category.toLowerCase()) {
      case 'airfare': return 'bg-sky-100 text-sky-800';
      case 'lodging': return 'bg-amber-100 text-amber-800';
      case 'meals': return 'bg-rose-100 text-rose-800';
      case 'transportation': return 'bg-teal-100 text-teal-800';
      case 'entertainment': return 'bg-purple-100 text-purple-800';
      default: return 'bg-slate-100 text-slate-800';
    }
  }

  exportPdf(): void {
    const reports = this.reports();
    if (!reports || reports.length === 0) return;

    const doc = new jsPDF();
    let yPos = 20;

    // Title
    doc.setFontSize(20);
    doc.setTextColor(30, 41, 59); // Slate 800
    doc.text('Travel Expense Report', 14, yPos);
    yPos += 15;

    reports.forEach((report, index) => {
      // Add page break if needed
      if (yPos > 250) {
        doc.addPage();
        yPos = 20;
      }

      // Trip Header
      doc.setFontSize(14);
      doc.setTextColor(71, 85, 105); // Slate 600
      doc.text(`Trip ${index + 1}: ${report.trip.startDate} to ${report.trip.endDate}`, 14, yPos);
      yPos += 8;

      doc.setFontSize(12);
      doc.setTextColor(30, 41, 59);
      doc.text(`Total: $${report.total.toFixed(2)}`, 14, yPos);
      yPos += 10;

      // Table
      const tableData = report.expenses.map(expense => [
        expense.date,
        expense.merchant,
        expense.description,
        expense.category,
        `$${expense.amount.toFixed(2)}`
      ]);

      autoTable(doc, {
        startY: yPos,
        head: [['Date', 'Merchant', 'Description', 'Category', 'Amount']],
        body: tableData,
        theme: 'grid',
        headStyles: { fillColor: [79, 70, 229] }, // Indigo 600
        styles: { fontSize: 8, cellPadding: 3 },
        columnStyles: {
          0: { cellWidth: 25 },
          1: { cellWidth: 35 },
          2: { cellWidth: 'auto' },
          3: { cellWidth: 25 },
          4: { cellWidth: 25, halign: 'right' }
        },
        didDrawPage: (data) => {
          // Reset yPos for next loop iteration if it spans multiple pages
          yPos = data.cursor ? data.cursor.y + 15 : 20;
        }
      });
      
      // Update yPos after table
      // @ts-ignore
      yPos = doc.lastAutoTable.finalY + 15;
    });

    doc.save('expense-report.pdf');
  }
}