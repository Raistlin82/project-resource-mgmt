import { AngularNodeAppEngine, isMainModule, writeResponseToNodeResponse, createNodeRequestHandler } from '@angular/ssr/node';
import express from 'express';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDistFolder = dirname(fileURLToPath(import.meta.url));
const browserDistFolder = resolve(serverDistFolder, '../browser');

const app = express();
const angularApp = new AngularNodeAppEngine();

app.use(express.json());

// --- API Routes ---
const apiRouter = express.Router();

const resources = [
  { 
    id: '1', 
    name: 'Julie Armstrong', 
    role: 'Developer', 
    skills: [{ name: 'Java', level: 3 }, { name: 'Spring', level: 2 }], 
    projectRoles: ['Senior Developer', 'Backend Engineer'],
    externalExperience: [
      { projectName: 'E-commerce Migration', company: 'TechCorp', role: 'Java Developer', startDate: '2020-01-01', endDate: '2022-12-31', comment: 'Migrated legacy system to Spring Boot.' }
    ],
    profilePicture: '',
    resume: '',
    utilization: 85, 
    capacity: 40,
    managerId: '1',
    organization: 'Engineering',
    location: 'New York, NY'
  },
  { 
    id: '2', 
    name: 'John Miller', 
    role: 'Consultant', 
    skills: [{ name: 'Project Management', level: 2 }], 
    projectRoles: ['Business Consultant'],
    externalExperience: [],
    profilePicture: '',
    resume: '',
    utilization: 115, 
    capacity: 40,
    managerId: '1',
    organization: 'Consulting',
    location: 'London, UK'
  },
  { 
    id: '3', 
    name: 'Alice Smith', 
    role: 'Designer', 
    skills: [{ name: 'Figma', level: 3 }], 
    projectRoles: ['UX Designer'],
    externalExperience: [],
    profilePicture: '',
    resume: '',
    utilization: 50, 
    capacity: 40,
    managerId: '2',
    organization: 'Design',
    location: 'Remote'
  },
];

const requests = [
  { id: '1', name: 'Project Alpha - Backend', requiredRole: 'Developer', requiredEffort: 20, staffedEffort: 20, status: 'Open', skills: ['Java'], description: 'Backend development for Project Alpha', startDate: '2026-04-01', endDate: '2026-06-30', requesterId: '1' },
  { id: '2', name: 'Project Beta - UI', requiredRole: 'Designer', requiredEffort: 15, staffedEffort: 0, status: 'Published', skills: ['Figma'], description: 'UI Design for Project Beta', startDate: '2026-05-01', endDate: '2026-07-31', requesterId: '1' },
];

const assignments = [
  { id: '1', requestId: '1', resourceId: '1', assignedHours: 20, status: 'hard-booked' }
];

let languages = [
  { code: 'en', name: 'English', isDefault: true },
  { code: 'de', name: 'German', isDefault: false },
  { code: 'es', name: 'Spanish', isDefault: false },
  { code: 'fr', name: 'French', isDefault: false },
];

let skillCatalogs = [
  { id: '1', name: 'Development Skills', description: 'Skills related to software development', skills: ['1', '2'] }
];

let proficiencySets = [
  { 
    id: '1', 
    name: 'Standard IT Proficiency', 
    description: 'Standard 1-5 level proficiency', 
    levels: [
      { id: 'l1', level: 1, name: 'Beginner', description: 'Basic knowledge' },
      { id: 'l2', level: 2, name: 'Intermediate', description: 'Practical application' },
      { id: 'l3', level: 3, name: 'Advanced', description: 'Applied theory' },
      { id: 'l4', level: 4, name: 'Expert', description: 'Recognized authority' }
    ] 
  }
];

let skills = [
  { id: '1', conceptUri: 'sap-rm://skill/1', name: 'Java', description: 'Java programming', catalogs: ['1'], proficiencySetId: '1', restricted: false },
  { id: '2', conceptUri: 'sap-rm://skill/2', name: 'JavaScript', description: 'JS programming', catalogs: ['1'], proficiencySetId: '1', restricted: false }
];

const projectRoles = [
  { id: '1', code: 'DEV', name: 'Developer', description: 'Software Developer', restricted: false },
  { id: '2', code: 'PM', name: 'Project Manager', description: 'Project Manager', restricted: false }
];

const serviceOrganizations = [
  { id: '1', code: 'SO_DE', description: 'Service Org Germany', costCenters: ['CC_DE_1', 'CC_DE_2'] }
];

let resourceOrganizations = [
  { id: '1', name: 'Res Org Germany', description: 'Resource Org for Germany', costCenters: ['CC_DE_1', 'CC_DE_2'], serviceOrganizationId: '1' }
];

let projects = [
  {
    id: '1',
    name: 'Project Alpha',
    location: 'Berlin, Germany',
    startDate: '2026-04-01',
    endDate: '2026-12-31',
    status: 'In Planning',
    description: 'A major software development project.',
    ownerId: '1'
  },
  {
    id: '2',
    name: 'Project Beta',
    location: 'Munich, Germany',
    startDate: '2026-05-01',
    endDate: '2027-05-01',
    status: 'In Execution',
    description: 'Infrastructure upgrade project.',
    ownerId: '1'
  }
];

apiRouter.get('/resources', (req, res) => res.json(resources));
apiRouter.get('/resources/:id', (req, res) => {
  const resource = resources.find(r => r.id === req.params.id);
  if (resource) {
    res.json(resource);
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});
apiRouter.put('/resources/:id', (req, res) => {
  const index = resources.findIndex(r => r.id === req.params.id);
  if (index !== -1) {
    resources[index] = { ...resources[index], ...req.body };
    res.json(resources[index]);
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});

apiRouter.get('/requests', (req, res) => res.json(requests));
apiRouter.post('/requests', (req, res) => {
  const newReq = { id: Date.now().toString(), staffedEffort: 0, ...req.body, status: 'Not Published' };
  requests.push(newReq);
  res.json(newReq);
});
apiRouter.put('/requests/:id', (req, res) => {
  const index = requests.findIndex(r => r.id === req.params.id);
  if (index !== -1) {
    requests[index] = { ...requests[index], ...req.body };
    res.json(requests[index]);
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});
apiRouter.delete('/requests/:id', (req, res) => {
  const index = requests.findIndex(r => r.id === req.params.id);
  if (index !== -1) {
    requests.splice(index, 1);
    res.status(204).send();
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});

apiRouter.get('/assignments', (req, res) => res.json(assignments));
apiRouter.post('/assignments', (req, res) => {
  const newAssig = { id: Date.now().toString(), ...req.body };
  assignments.push(newAssig);
  
  // Update resource utilization
  const resource = resources.find(r => r.id === newAssig.resourceId);
  if (resource) {
    resource.utilization += (newAssig.assignedHours / resource.capacity) * 100;
  }

  // Update request staffedEffort
  const request = requests.find(r => r.id === newAssig.requestId);
  if (request) {
    request.staffedEffort += newAssig.assignedHours;
    if (request.staffedEffort >= request.requiredEffort) {
      request.status = 'Fulfilled';
    }
  }

  res.json(newAssig);
});
apiRouter.put('/assignments/:id', (req, res) => {
  const index = assignments.findIndex(a => a.id === req.params.id);
  if (index !== -1) {
    const oldAssig = assignments[index];
    const newAssig = { ...oldAssig, ...req.body };
    assignments[index] = newAssig;
    
    // Update resource utilization
    const resource = resources.find(r => r.id === newAssig.resourceId);
    if (resource) {
      resource.utilization += ((newAssig.assignedHours - oldAssig.assignedHours) / resource.capacity) * 100;
    }

    // Update request staffedEffort
    if (oldAssig.requestId === newAssig.requestId) {
      const request = requests.find(r => r.id === newAssig.requestId);
      if (request) {
        request.staffedEffort += (newAssig.assignedHours - oldAssig.assignedHours);
        if (request.staffedEffort >= request.requiredEffort) {
          request.status = 'Fulfilled';
        } else if (request.status === 'Fulfilled' && request.staffedEffort < request.requiredEffort) {
          request.status = 'Open';
        }
      }
    } else {
      // If request ID changed (unlikely but possible)
      const oldReq = requests.find(r => r.id === oldAssig.requestId);
      if (oldReq) {
        oldReq.staffedEffort -= oldAssig.assignedHours;
        if (oldReq.status === 'Fulfilled' && oldReq.staffedEffort < oldReq.requiredEffort) {
          oldReq.status = 'Open';
        }
      }
      const newReq = requests.find(r => r.id === newAssig.requestId);
      if (newReq) {
        newReq.staffedEffort += newAssig.assignedHours;
        if (newReq.staffedEffort >= newReq.requiredEffort) {
          newReq.status = 'Fulfilled';
        }
      }
    }

    res.json(newAssig);
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});
apiRouter.delete('/assignments/:id', (req, res) => {
  const index = assignments.findIndex(a => a.id === req.params.id);
  if (index !== -1) {
    const oldAssig = assignments[index];
    assignments.splice(index, 1);
    
    // Update resource utilization
    const resource = resources.find(r => r.id === oldAssig.resourceId);
    if (resource) {
      resource.utilization -= (oldAssig.assignedHours / resource.capacity) * 100;
    }

    // Update request staffedEffort
    const request = requests.find(r => r.id === oldAssig.requestId);
    if (request) {
      request.staffedEffort -= oldAssig.assignedHours;
      if (request.status === 'Fulfilled' && request.staffedEffort < request.requiredEffort) {
        request.status = 'Open';
      }
    }

    res.status(204).send();
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});

// --- Configuration Endpoints ---

apiRouter.get('/languages', (req, res) => res.json(languages));
apiRouter.post('/languages/default', (req, res) => {
  const { code } = req.body;
  languages = languages.map(l => ({ ...l, isDefault: l.code === code }));
  res.status(204).send();
});

apiRouter.get('/skill-catalogs', (req, res) => res.json(skillCatalogs));
apiRouter.post('/skill-catalogs', (req, res) => {
  const newCat = { id: Date.now().toString(), skills: [], ...req.body };
  skillCatalogs.push(newCat);
  res.json(newCat);
});
apiRouter.put('/skill-catalogs/:id', (req, res) => {
  const index = skillCatalogs.findIndex(c => c.id === req.params.id);
  if (index !== -1) {
    skillCatalogs[index] = { ...skillCatalogs[index], ...req.body };
    res.json(skillCatalogs[index]);
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});
apiRouter.delete('/skill-catalogs/:id', (req, res) => {
  skillCatalogs = skillCatalogs.filter(c => c.id !== req.params.id);
  res.status(204).send();
});

apiRouter.get('/proficiency-sets', (req, res) => res.json(proficiencySets));
apiRouter.post('/proficiency-sets', (req, res) => {
  const newSet = { id: Date.now().toString(), levels: [], ...req.body };
  proficiencySets.push(newSet);
  res.json(newSet);
});
apiRouter.delete('/proficiency-sets/:id', (req, res) => {
  proficiencySets = proficiencySets.filter(s => s.id !== req.params.id);
  res.status(204).send();
});

apiRouter.get('/skills', (req, res) => res.json(skills));
apiRouter.post('/skills', (req, res) => {
  const newSkill = { id: Date.now().toString(), conceptUri: `sap-rm://skill/${Date.now()}`, catalogs: [], restricted: false, ...req.body };
  skills.push(newSkill);
  res.json(newSkill);
});
apiRouter.put('/skills/:id', (req, res) => {
  const index = skills.findIndex(s => s.id === req.params.id);
  if (index !== -1) {
    skills[index] = { ...skills[index], ...req.body };
    res.json(skills[index]);
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});
apiRouter.delete('/skills/:id', (req, res) => {
  skills = skills.filter(s => s.id !== req.params.id);
  res.status(204).send();
});

apiRouter.get('/project-roles', (req, res) => res.json(projectRoles));
apiRouter.post('/project-roles', (req, res) => {
  const newRole = { id: Date.now().toString(), restricted: false, ...req.body };
  projectRoles.push(newRole);
  res.json(newRole);
});
apiRouter.put('/project-roles/:id', (req, res) => {
  const index = projectRoles.findIndex(r => r.id === req.params.id);
  if (index !== -1) {
    projectRoles[index] = { ...projectRoles[index], ...req.body };
    res.json(projectRoles[index]);
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});

apiRouter.get('/service-organizations', (req, res) => res.json(serviceOrganizations));

apiRouter.get('/resource-organizations', (req, res) => res.json(resourceOrganizations));
apiRouter.post('/resource-organizations', (req, res) => {
  const newOrg = { id: Date.now().toString(), costCenters: [], ...req.body };
  resourceOrganizations.push(newOrg);
  res.json(newOrg);
});
apiRouter.put('/resource-organizations/:id', (req, res) => {
  const index = resourceOrganizations.findIndex(o => o.id === req.params.id);
  if (index !== -1) {
    resourceOrganizations[index] = { ...resourceOrganizations[index], ...req.body };
    res.json(resourceOrganizations[index]);
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});
apiRouter.delete('/resource-organizations/:id', (req, res) => {
  resourceOrganizations = resourceOrganizations.filter(o => o.id !== req.params.id);
  res.status(204).send();
});

apiRouter.get('/projects', (req, res) => res.json(projects));
apiRouter.post('/projects', (req, res) => {
  const newProject = { id: Date.now().toString(), ...req.body };
  projects.push(newProject);
  res.json(newProject);
});
apiRouter.put('/projects/:id', (req, res) => {
  const index = projects.findIndex(p => p.id === req.params.id);
  if (index !== -1) {
    projects[index] = { ...projects[index], ...req.body };
    res.json(projects[index]);
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});
apiRouter.delete('/projects/:id', (req, res) => {
  projects = projects.filter(p => p.id !== req.params.id);
  res.status(204).send();
});

app.use('/api', apiRouter);
// ------------------

app.use(
  express.static(browserDistFolder, {
    maxAge: '1y',
    index: false,
    redirect: false,
  }),
);

app.use((req, res, next) => {
  angularApp
    .handle(req)
    .then((response) =>
      response ? writeResponseToNodeResponse(response, res) : next(),
    )
    .catch(next);
});

if (isMainModule(import.meta.url)) {
  const port = process.env['PORT'] || 3000;
  app.listen(port, () => {
    console.log(`Node Express server listening on http://localhost:${port}`);
  });
}

export const reqHandler = createNodeRequestHandler(app);
