import { createContext, PropsWithChildren, useContext, useEffect, useMemo, useState } from 'react';

import { CAMPUSES, CampusId } from '@/constants/campuses';
import { fetchReportFeed } from '@/services/routing-api';
import { ReportFeed, RouteResponseMode, TrashReport } from '@/types/routing';

type EnabledCampuses = Record<CampusId, boolean>;

type ReporterContextValue = {
  selectedCampusId: CampusId;
  enabledCampuses: EnabledCampuses;
  reportFeed: ReportFeed;
  feedBusy: boolean;
  submittedReport: TrashReport | null;
  submitMode: RouteResponseMode | null;
  setSelectedCampusId: (campusId: CampusId) => void;
  toggleCampus: (campusId: CampusId) => void;
  refreshReportFeed: (showError?: boolean) => Promise<void>;
  registerSubmission: (report: TrashReport, mode: RouteResponseMode) => void;
};

const defaultEnabledCampuses: EnabledCampuses = {
  'college-avenue': true,
  busch: true,
  livingston: true,
};

const emptyFeed: ReportFeed = {
  activeAssignmentId: null,
  reports: [],
};

const ReporterContext = createContext<ReporterContextValue | null>(null);

export function ReporterProvider({ children }: PropsWithChildren) {
  const [selectedCampusId, setSelectedCampusId] = useState<CampusId>('college-avenue');
  const [enabledCampuses, setEnabledCampuses] = useState<EnabledCampuses>(defaultEnabledCampuses);
  const [reportFeed, setReportFeed] = useState<ReportFeed>(emptyFeed);
  const [feedBusy, setFeedBusy] = useState(false);
  const [submittedReport, setSubmittedReport] = useState<TrashReport | null>(null);
  const [submitMode, setSubmitMode] = useState<RouteResponseMode | null>(null);

  useEffect(() => {
    void refreshReportFeed(false);

    const interval = setInterval(() => {
      void refreshReportFeed(false);
    }, 15000);

    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (enabledCampuses[selectedCampusId]) {
      return;
    }

    const fallbackCampus = CAMPUSES.find((campus) => enabledCampuses[campus.id]);
    if (fallbackCampus) {
      setSelectedCampusId(fallbackCampus.id);
    }
  }, [enabledCampuses, selectedCampusId]);

  async function refreshReportFeed(showError = false) {
    try {
      setFeedBusy(true);
      const nextFeed = await fetchReportFeed();
      setReportFeed(nextFeed);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isOfflineOrTimeout = /timed out|network request failed|failed to fetch|aborted/i.test(
        message
      );
      if (showError || !isOfflineOrTimeout) {
        console.warn('[reporter-context] report feed refresh failed', message);
      }
    } finally {
      setFeedBusy(false);
    }
  }

  function toggleCampus(campusId: CampusId) {
    setEnabledCampuses((current) => {
      const enabledCount = Object.values(current).filter(Boolean).length;
      if (current[campusId] && enabledCount === 1) {
        return current;
      }

      return {
        ...current,
        [campusId]: !current[campusId],
      };
    });
  }

  function registerSubmission(report: TrashReport, mode: RouteResponseMode) {
    setSubmittedReport(report);
    setSubmitMode(mode);
  }

  const value = useMemo<ReporterContextValue>(
    () => ({
      selectedCampusId,
      enabledCampuses,
      reportFeed,
      feedBusy,
      submittedReport,
      submitMode,
      setSelectedCampusId,
      toggleCampus,
      refreshReportFeed,
      registerSubmission,
    }),
    [
      enabledCampuses,
      feedBusy,
      reportFeed,
      selectedCampusId,
      submitMode,
      submittedReport,
    ]
  );

  return <ReporterContext.Provider value={value}>{children}</ReporterContext.Provider>;
}

export function useReporterContext() {
  const context = useContext(ReporterContext);
  if (!context) {
    throw new Error('useReporterContext must be used within ReporterProvider');
  }

  return context;
}
