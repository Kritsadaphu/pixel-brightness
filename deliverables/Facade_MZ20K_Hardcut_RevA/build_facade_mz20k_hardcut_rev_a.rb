# frozen_string_literal: true

# Full SketchUp generator: curved facade + two portrait PT-MZ20K projectors,
# full optical beams, and an architectural hard cut with no edge blending.
require 'sketchup.rb'
require 'fileutils'

module FacadeMZ20KHardcutRevA
  extend self

  M = 1.m
  WALL_W = 14.40
  WALL_H = 13.40
  MAX_H = 14.40
  HARD_CUT_X = 6.62
  THROW = 20.00
  LENS_Z = 3.00
  PORTRAIT_W = WALL_H * 1200.0 / 1920.0
  LEFT_X = HARD_CUT_X / 2.0
  RIGHT_X = HARD_CUT_X + (WALL_W - HARD_CUT_X) / 2.0
  THROW_RATIO = THROW / WALL_H
  BEAM_OVERLAP = PORTRAIT_W - (RIGHT_X - LEFT_X)

  OUTPUT_DIR = '/Users/kritsadaphuechsing/Documents/ChatGPT/Program Display/deliverables/Facade_MZ20K_Hardcut_RevA'
  OUTPUT_SKP = File.join(OUTPUT_DIR, 'Facade_PT-MZ20K_2x_Portrait_CurvedSurface_Hardcut_NoBlend_RevB.skp')

  BAYS = [
    { x0: 0.00,  x1: 2.62,  depth: 0.80, bottom: 0.40, edge: 5.30, top0: 12.90, top1: 13.40 },
    { x0: 2.62,  x1: 4.62,  depth: 1.15, bottom: 0.70, edge: 5.80, top0: 13.40, top1: 13.10 },
    { x0: 4.62,  x1: 6.62,  depth: 1.30, bottom: 0.20, edge: 5.40, top0: 13.10, top1: 12.70 },
    { x0: 6.62,  x1: 8.32,  depth: 1.05, bottom: 0.20, edge: 5.10, top0: 12.70, top1: 12.90 },
    { x0: 8.32,  x1: 11.17, depth: 1.45, bottom: 0.35, edge: 5.80, top0: 12.90, top1: 12.40 },
    { x0: 11.17, x1: 13.12, depth: 1.05, bottom: 0.30, edge: 5.20, top0: 12.40, top1: 13.00 },
    { x0: 13.12, x1: 14.40, depth: 0.70, bottom: 0.45, edge: 4.80, top0: 13.00, top1: 13.40 }
  ].freeze

  def pt(x, y, z = 0)
    Geom::Point3d.new(x * M, y * M, z * M)
  end

  def vec(x, y, z = 0)
    Geom::Vector3d.new(x * M, y * M, z * M)
  end

  def material(model, name, rgb, alpha = 1.0)
    mat = model.materials[name] || model.materials.add(name)
    mat.color = Sketchup::Color.new(*rgb)
    mat.alpha = alpha
    mat
  end

  def tag(model, name)
    model.layers[name] || model.layers.add(name)
  end

  def paint(group, mat)
    group.material = mat
    group.entities.grep(Sketchup::Face).each do |face|
      face.material = mat
      face.back_material = mat
    end
  end

  def box(entities, x0, y0, z0, x1, y1, z1, mat, name = nil, layer = nil)
    group = entities.add_group
    group.name = name if name
    group.layer = layer if layer
    face = group.entities.add_face(pt(x0,y0,z0), pt(x1,y0,z0), pt(x1,y1,z0), pt(x0,y1,z0))
    face.reverse! if face.normal.z < 0
    face.pushpull((z1-z0) * M)
    paint(group, mat)
    group
  end

  def tube_between(entities, a, b, radius, mat, name = nil, sides = 10)
    group = entities.add_group
    group.name = name if name
    p1 = pt(*a); p2 = pt(*b); axis = p2 - p1
    edges = group.entities.add_circle(p1, axis, radius * M, sides)
    face = group.entities.add_face(edges)
    face.reverse! if face.normal.dot(axis) < 0
    face.pushpull(axis.length)
    paint(group, mat)
    group
  end

  def circular_arc_y(spec, x)
    span=spec[:x1]-spec[:x0]
    half=span/2.0
    depth=spec[:depth]
    radius=(half*half+depth*depth)/(2.0*depth)
    dx=x-(spec[:x0]+spec[:x1])/2.0
    (radius-depth)-Math.sqrt([radius*radius-dx*dx,0.0].max)
  end

  def facade_y_at(x)
    spec=BAYS.find { |b| x >= b[:x0]-0.0001 && x <= b[:x1]+0.0001 }
    return 0.0 unless spec
    circular_arc_y(spec,x)
  end

  def curved_ribbon(entities, spec, mat, layer, index, y_offset = 0.0)
    group = entities.add_group
    group.name = format('CURVED FACADE RIBBON %02d / GRID %.2f-%.2f', index+1, spec[:x0], spec[:x1])
    group.layer = layer
    segments = 28
    outer = []
    inner = []
    thickness = 0.12

    (0..segments).each do |i|
      u = i / segments.to_f
      x = spec[:x0] + (spec[:x1]-spec[:x0]) * u
      # True circular arc in plan. Negative Y projects toward the audience.
      y = circular_arc_y(spec,x)-y_offset
      # Rounded inverted arch in elevation: high at grooves, low at bay centre.
      arch = 0.5+0.5*Math.cos(2.0*Math::PI*u)
      bottom = spec[:bottom] + (spec[:edge]-spec[:bottom]) * arch
      top = spec[:top0] + (spec[:top1]-spec[:top0]) * u
      outer << [pt(x,y,bottom), pt(x,y,top)]
      inner << [pt(x,y+thickness,bottom), pt(x,y+thickness,top)]
    end

    (0...segments).each do |i|
      [[outer, false], [inner, true]].each do |surface, reverse|
        face = group.entities.add_face(surface[i][0], surface[i+1][0], surface[i+1][1], surface[i][1])
        face.reverse! if face && reverse
        if face
          face.material = mat
          face.back_material = mat
        end
      end
      top_face = group.entities.add_face(outer[i][1], inner[i][1], inner[i+1][1], outer[i+1][1])
      bottom_face = group.entities.add_face(outer[i+1][0], inner[i+1][0], inner[i][0], outer[i][0])
      [top_face,bottom_face].compact.each { |f| f.material=mat; f.back_material=mat }
    end
    [0, segments].each do |i|
      side = group.entities.add_face(outer[i][0], inner[i][0], inner[i][1], outer[i][1])
      side.material=mat if side
      side.back_material=mat if side
    end
    group.entities.grep(Sketchup::Edge).each do |edge|
      next if edge.faces.length < 2
      edge.soft = true
      edge.smooth = true
    end

    group
  end

  def spiral_stair(entities, cx, cy, z0, z1, radius, mat, layer, name)
    group = entities.add_group
    group.name = name
    group.layer = layer
    tube_between(group.entities, [cx,cy,z0], [cx,cy,z1], 0.10, mat, 'Central stair column', 14)
    steps = 32
    rise = (z1-z0) / steps.to_f
    steps.times do |i|
      angle = i * (Math::PI * 2.0 / 18.0)
      tread = box(group.entities, cx-0.12, cy, z0+i*rise, cx+0.12, cy+radius, z0+i*rise+0.065, mat, "Step #{i+1}")
      tread.transform!(Geom::Transformation.rotation(pt(cx,cy,z0+i*rise), Z_AXIS, angle))
      if (i % 3).zero?
        px = cx + radius * 0.92 * Math.sin(-angle)
        py = cy + radius * 0.92 * Math.cos(angle)
        tube_between(group.entities, [px,py,z0+i*rise], [px,py,z0+i*rise+1.0], 0.022, mat, nil, 8)
      end
    end
    group
  end

  def truss_tower(entities, cx, cy, h, mat, deck_mat, layer, name)
    group = entities.add_group
    group.name = name
    group.layer = layer
    half = 0.75
    posts = [[cx-half,cy-half],[cx+half,cy-half],[cx+half,cy+half],[cx-half,cy+half]]
    posts.each_with_index { |(x,y),i| tube_between(group.entities,[x,y,0],[x,y,h],0.055,mat,"Post #{i+1}",10) }
    levels = (0..(h/1.0).floor).map(&:to_f) + [h]
    levels.uniq.each do |z|
      posts.each_with_index do |a,i|
        b=posts[(i+1)%4]
        tube_between(group.entities,[a[0],a[1],z],[b[0],b[1],z],0.040,mat,nil,8)
      end
    end
    4.times do |i|
      a=posts[i]; b=posts[(i+1)%4]
      (0...(levels.length-1)).each do |j|
        z0=levels[j]; z1=levels[j+1]
        from=j.even? ? a : b; to=j.even? ? b : a
        tube_between(group.entities,[from[0],from[1],z0],[to[0],to[1],z1],0.025,mat,nil,8)
      end
    end
    box(group.entities,cx-half,cy-half,h-0.16,cx+half,cy+half,h-0.08,deck_mat,'Projector deck')
    group
  end

  def add_projector(entities, cx, cy, lens_z, target, body_mat, lens_mat, layer, name)
    group = entities.add_group
    group.name = name
    group.layer = layer
    # PT-MZ20K body in portrait: 0.211 m wide, 0.440 m deep, 0.650 m tall.
    box(group.entities,cx-0.1055,cy-0.34,lens_z-0.325,cx+0.1055,cy+0.10,lens_z+0.325,body_mat,'PT-MZ20K body portrait')
    tube_between(group.entities,[cx,cy+0.10,lens_z],[cx,cy+0.29,lens_z],0.075,lens_mat,'ET-EMS650 lens',20)
    group.set_attribute('ProjectionLayout','Model','Panasonic PT-MZ20K')
    group.set_attribute('ProjectionLayout','Orientation','Portrait 90 degrees')
    group.set_attribute('ProjectionLayout','Lens','ET-EMS650')
    group.set_attribute('ProjectionLayout','NominalLumens',20_000)
    group.set_attribute('ProjectionLayout','ThrowM',THROW)
    group.set_attribute('ProjectionLayout','ThrowRatio',THROW_RATIO.round(3))
    group.set_attribute('ProjectionLayout','Target',target)
    group
  end

  def beam_frustum(entities, cx, mat, layer, name)
    group = entities.add_group
    group.name = name
    group.layer = layer
    apex = pt(cx,-THROW,LENS_Z)
    half = PORTRAIT_W/2.0
    x0=[cx-half,0.0].max
    x1=[cx+half,WALL_W].min
    samples=42
    curve=(0..samples).map do |i|
      x=x0+(x1-x0)*i/samples.to_f
      y=facade_y_at(x)-0.05
      [pt(x,y,0),pt(x,y,WALL_H)]
    end
    # Ruled beam envelope terminates on the curved facade, not a flat plane.
    (0...samples).each do |i|
      [[curve[i][0],curve[i+1][0]],[curve[i+1][1],curve[i][1]]].each do |a,b|
        face=group.entities.add_face(apex,a,b)
        if face
          face.material=mat
          face.back_material=mat
        end
      end
    end
    [curve.first,curve.last].each do |pair|
      face=group.entities.add_face(apex,pair[0],pair[1])
      if face
        face.material=mat
        face.back_material=mat
      end
    end
    group.set_attribute('ProjectionLayout','FullOpticalFootprintM',format('%.3f x %.2f',PORTRAIT_W,WALL_H))
    group
  end

  def add_3d_text(entities, text, x, y, z, height, mat, layer)
    group=entities.add_group
    group.layer=layer
    group.entities.add_3d_text(text,TextAlignCenter,'Arial',false,false,height*M,0,0,true,0.015*M)
    group.transform!(Geom::Transformation.translation(pt(x,y,z)))
    paint(group,mat)
    group
  end

  def build
    FileUtils.mkdir_p(OUTPUT_DIR)
    model=Sketchup.active_model
    model.start_operation('Build Facade MZ20K Hardcut RevA',true)
    model.entities.clear!
    model.pages.to_a.each { |p| model.pages.erase(p) }
    model.materials.purge_unused
    model.layers.purge_unused

    tags={}
    %w[00_SITE 01_CONTEXT 02_FACADE_CURVED 03_STAIRS 04_RIG_TOWERS 05_PROJECTORS 06_FULL_OPTICAL_BEAMS 07_ACTIVE_ZONES 08_HARDCUT 09_DIMS_LABELS].each { |n| tags[n]=tag(model,n) }

    beige=material(model,'Warm Beige Facade',[196,177,148])
    beige_dark=material(model,'Facade Side',[151,127,98])
    red=material(model,'Stair Red',[130,35,37])
    paving=material(model,'Site Ground',[95,99,101])
    context_mat=material(model,'Context White',[215,218,220])
    truss=material(model,'Aluminium Truss',[108,117,125])
    deck=material(model,'Tower Deck',[58,63,68])
    body=material(model,'PT-MZ20K Body',[26,29,34])
    lens=material(model,'ET-EMS650 Lens',[40,75,105])
    beam_l=material(model,'PJ-L Full Optical Beam',[34,145,255],0.30)
    beam_r=material(model,'PJ-R Full Optical Beam',[255,82,42],0.30)
    active_l=material(model,'PJ-L Active Hardcut Zone',[35,145,255],0.26)
    active_r=material(model,'PJ-R Active Hardcut Zone',[255,82,42],0.26)
    cut_mat=material(model,'Hard Cut Yellow',[255,226,45])
    label_mat=material(model,'Label White',[245,247,250])

    root=model.entities.add_group
    root.name='FACADE PROJECTION — 2x PT-MZ20K PORTRAIT HARD CUT'
    root.set_attribute('ProjectionLayout','Revision','RevB curved projection surface')
    root.set_attribute('ProjectionLayout','FacadeEnvelopeM','14.40 W x 13.40 H')
    root.set_attribute('ProjectionLayout','ProjectorCount',2)
    root.set_attribute('ProjectionLayout','Transition','Hard cut at Grid 16; no edge blend')
    root.set_attribute('ProjectionLayout','HardCutX_M',HARD_CUT_X)
    root.set_attribute('ProjectionLayout','BeamOverlapM',BEAM_OVERLAP.round(3))
    e=root.entities

    box(e,-3,-22,-0.18,WALL_W+3,4,0,paving,'SITE / PROJECTION THROW AREA',tags['00_SITE'])
    (0..4).each { |i| e.add_line(pt(-2,-i*5,0.01),pt(WALL_W+2,-i*5,0.01)).layer=tags['00_SITE'] }
    box(e,-2,0,0,0,2.0,11.5,context_mat,'LEFT CONTEXT MASS',tags['01_CONTEXT'])
    box(e,WALL_W,0,0,WALL_W+2.2,2.0,11.8,context_mat,'RIGHT CONTEXT MASS',tags['01_CONTEXT'])

    facade=e.add_group
    facade.name='CURVED RIBBON FACADE — APPROX FROM SUPPLIED DRAWING'
    facade.layer=tags['02_FACADE_CURVED']
    BAYS.each_with_index do |spec,i|
      zone_mat = spec[:x1] <= HARD_CUT_X ? active_l : active_r
      curved_ribbon(facade.entities,spec,beige,tags['02_FACADE_CURVED'],i,0.0)
      curved_ribbon(e,spec,zone_mat,tags['07_ACTIVE_ZONES'],i,0.025)
    end
    # Thin vertical fins emphasize the actual architectural grooves.
    BAYS[1..].each_with_index do |spec,i|
      x=spec[:x0]
      box(e,x-0.025,-0.14,0,x+0.025,0.05,WALL_H,beige_dark,"GROOVE GRID #{i+1}",tags['02_FACADE_CURVED'])
    end

    stairs=e.add_group
    stairs.name='VISIBLE SPIRAL STAIRS — APPROX'
    stairs.layer=tags['03_STAIRS']
    spiral_stair(stairs.entities,3.35,0.18,0.0,5.8,0.92,red,tags['03_STAIRS'],'STAIR ST-LEFT')
    spiral_stair(stairs.entities,6.70,0.18,0.0,6.2,0.95,red,tags['03_STAIRS'],'STAIR ST-CENTRE')
    spiral_stair(stairs.entities,10.85,0.18,0.0,5.8,0.92,red,tags['03_STAIRS'],'STAIR ST-RIGHT')

    # Hard cut follows Grid 16 groove at x=6.62 m.
    cut=e.add_group
    cut.name='HARD CUT @ GRID 16 — NO BLENDING'
    cut.layer=tags['08_HARDCUT']
    cut.entities.add_line(pt(HARD_CUT_X,-0.85,0),pt(HARD_CUT_X,-0.85,WALL_H)).material=cut_mat
    27.times do |i|
      next unless i.even?
      box(cut.entities,HARD_CUT_X-0.035,-0.90,i*0.5,HARD_CUT_X+0.035,-0.82,[i*0.5+0.30,WALL_H].min,cut_mat,"Cut marker #{i+1}")
    end

    rig=e.add_group
    rig.name='2x PROJECTOR TRUSS TOWERS'
    rig.layer=tags['04_RIG_TOWERS']
    truss_tower(rig.entities,LEFT_X,-THROW,3.42,truss,deck,tags['04_RIG_TOWERS'],'TOWER PJ-L')
    truss_tower(rig.entities,RIGHT_X,-THROW,3.42,truss,deck,tags['04_RIG_TOWERS'],'TOWER PJ-R')

    projectors=e.add_group
    projectors.name='2x PT-MZ20K + ET-EMS650 / PORTRAIT'
    projectors.layer=tags['05_PROJECTORS']
    add_projector(projectors.entities,LEFT_X,-THROW,LENS_Z,'LEFT / x0.00-6.62',body,lens,tags['05_PROJECTORS'],'PJ-L PT-MZ20K PORTRAIT')
    add_projector(projectors.entities,RIGHT_X,-THROW,LENS_Z,'RIGHT / x6.62-14.40',body,lens,tags['05_PROJECTORS'],'PJ-R PT-MZ20K PORTRAIT')

    beams=e.add_group
    beams.name='FULL OPTICAL BEAMS — OVERLAP BUT NOT BLENDED'
    beams.layer=tags['06_FULL_OPTICAL_BEAMS']
    beam_frustum(beams.entities,LEFT_X,beam_l,tags['06_FULL_OPTICAL_BEAMS'],'PJ-L FULL OPTICAL FRAME')
    beam_frustum(beams.entities,RIGHT_X,beam_r,tags['06_FULL_OPTICAL_BEAMS'],'PJ-R FULL OPTICAL FRAME')

    dims=e.add_group
    dims.name='DIMENSIONS AND LABELS'
    dims.layer=tags['09_DIMS_LABELS']
    dims.entities.add_dimension_linear(pt(0,-0.2,0),pt(WALL_W,-0.2,0),vec(0,-1.2,0))
    dims.entities.add_dimension_linear(pt(-0.4,0,0),pt(-0.4,0,WALL_H),vec(-1.0,0,0))
    dims.entities.add_dimension_linear(pt(-1.8,0,0),pt(-1.8,-THROW,0),vec(-0.8,0,0))
    dims.entities.add_dimension_linear(pt(0,-1.2,0),pt(HARD_CUT_X,-1.2,0),vec(0,-0.6,0))
    add_3d_text(dims.entities,'2x PT-MZ20K / PORTRAIT / ET-EMS650',WALL_W/2,-1.6,WALL_H+1.2,0.42,label_mat,tags['09_DIMS_LABELS'])
    add_3d_text(dims.entities,'HARD CUT @ GRID 16 / NO BLENDING',HARD_CUT_X,-1.2,WALL_H+0.5,0.28,cut_mat,tags['09_DIMS_LABELS'])
    add_3d_text(dims.entities,format('THROW %.2f m / TR %.3f:1 / LENS CL +%.2f m',THROW,THROW_RATIO,LENS_Z),WALL_W/2,-18.5,0.4,0.25,label_mat,tags['09_DIMS_LABELS'])

    model.set_attribute('ProjectionLayout','ProjectorModel','Panasonic PT-MZ20K')
    model.set_attribute('ProjectionLayout','Lens','ET-EMS650')
    model.set_attribute('ProjectionLayout','Orientation','Portrait 90 degrees')
    model.set_attribute('ProjectionLayout','ProjectorCount',2)
    model.set_attribute('ProjectionLayout','ThrowM',THROW)
    model.set_attribute('ProjectionLayout','ThrowRatio',THROW_RATIO.round(3))
    model.set_attribute('ProjectionLayout','LensCenterZ_M',LENS_Z)
    model.set_attribute('ProjectionLayout','HardCutX_M',HARD_CUT_X)
    model.set_attribute('ProjectionLayout','EdgeBlend','None')
    model.set_attribute('ProjectionLayout','SurveyStatus','Preliminary geometry from supplied 1:100 raster drawing; verify on site')

    units=model.options['UnitsOptions']
    units['LengthUnit']=4
    units['LengthFormat']=0
    units['LengthPrecision']=2
    model.rendering_options['BackgroundColor']=Sketchup::Color.new(25,31,38)
    model.rendering_options['SkyColor']=Sketchup::Color.new(25,31,38)
    model.rendering_options['GroundColor']=Sketchup::Color.new(65,68,72)
    model.rendering_options['DisplayColorByLayer']=false
    model.options['PageOptions']['ShowTransition']=false
    model.commit_operation

    view=model.active_view
    pages=model.pages
    show_projection=lambda do |page,visible|
      page.set_visibility(tags['06_FULL_OPTICAL_BEAMS'],visible)
      page.set_visibility(tags['07_ACTIVE_ZONES'],visible)
      page.set_visibility(tags['08_HARDCUT'],true)
      page.set_visibility(tags['05_PROJECTORS'],true)
      page.set_visibility(tags['04_RIG_TOWERS'],true)
    end
    view.camera=Sketchup::Camera.new(pt(24,-30,19),pt(WALL_W/2,-3,6.7),Z_AXIS,true)
    view.zoom_extents
    hero_page=pages.add('01_Hero_Perspective')
    hero_page.update(1|2|4|8|16|32)
    show_projection.call(hero_page,true)
    view.camera=Sketchup::Camera.new(pt(WALL_W/2,-38,7),pt(WALL_W/2,0,7),Z_AXIS,false)
    view.camera.height=28.0*M
    front_page=pages.add('02_Front_HardCut')
    front_page.update(1|2|4|8|16|32)
    show_projection.call(front_page,true)
    view.camera=Sketchup::Camera.new(pt(WALL_W/2,-9,34),pt(WALL_W/2,-9,0),vec(0,1,0),false)
    view.camera.height=34.0*M
    top_page=pages.add('03_Top_BeamPlan')
    top_page.update(1|2|4|8|16|32)
    show_projection.call(top_page,true)
    view.camera=Sketchup::Camera.new(pt(21,-11,10),pt(WALL_W/2,-9,4),Z_AXIS,true)
    view.zoom_extents
    rig_page=pages.add('04_Rig_and_Projectors')
    rig_page.update(1|2|4|8|16|32)
    show_projection.call(rig_page,true)
    tags['06_FULL_OPTICAL_BEAMS'].visible=false
    tags['07_ACTIVE_ZONES'].visible=false
    view.camera=Sketchup::Camera.new(pt(22,-23,17),pt(WALL_W/2,0,6.5),Z_AXIS,true)
    view.zoom_extents
    geometry_page=pages.add('05_Facade_Geometry')
    geometry_page.update(1|2|4|8|16|32)
    show_projection.call(geometry_page,false)
    tags['06_FULL_OPTICAL_BEAMS'].visible=true
    tags['07_ACTIVE_ZONES'].visible=true
    pages.selected_page=hero_page

    model.save(OUTPUT_SKP)
    # Export with explicit cameras. This avoids capturing an in-between frame
    # when SketchUp scene transitions are enabled in the user's preferences.
    exports = [
      ['01_Hero_Perspective.png', true,  pt(24,-30,19),           pt(WALL_W/2,-3,6.7), Z_AXIS, nil,  true,  true],
      ['02_Front_HardCut.png',    false, pt(WALL_W/2,-38,7),      pt(WALL_W/2,0,7),    Z_AXIS, 20.0, true,  true],
      ['03_Top_BeamPlan.png',     false, pt(WALL_W/2,-9,34),      pt(WALL_W/2,-9,0),   vec(0,1,0), 30.0, true, true],
      ['04_Rig_and_Projectors.png',true, pt(21,-11,10),           pt(WALL_W/2,-9,4),   Z_AXIS, nil,  true,  true],
      ['05_Facade_Geometry.png',  true,  pt(22,-23,17),           pt(WALL_W/2,0,6.5),  Z_AXIS, nil,  false, false]
    ]
    exports.each do |file,perspective,eye,target,up,height,show_beams,show_active|
      tags['06_FULL_OPTICAL_BEAMS'].visible=show_beams
      tags['07_ACTIVE_ZONES'].visible=show_active
      cam=Sketchup::Camera.new(eye,target,up,perspective)
      cam.height=height*M if height
      view.camera=cam
      view.zoom_extents if perspective
      view.refresh
      sleep(0.35)
      view.write_image(filename:File.join(OUTPUT_DIR,file),width:2000,height:1250,antialias:true,transparent:false)
    end
    tags['06_FULL_OPTICAL_BEAMS'].visible=true
    tags['07_ACTIVE_ZONES'].visible=true
    pages.selected_page=hero_page
    view.refresh
    sleep(0.75)
    model.save(OUTPUT_SKP)

    File.write(File.join(OUTPUT_DIR,'Projector_Schedule.csv'),<<~CSV)
      ID,Model,Lens,Orientation,Lumens,Center X (m),Throw (m),Lens CL Z (m),Throw Ratio,Active Zone,Transition
      PJ-L,PT-MZ20K,ET-EMS650,Portrait,20000,#{LEFT_X.round(2)},#{THROW},#{LENS_Z},#{THROW_RATIO.round(3)},x 0.00-#{HARD_CUT_X},Hard cut no blend
      PJ-R,PT-MZ20K,ET-EMS650,Portrait,20000,#{RIGHT_X.round(2)},#{THROW},#{LENS_Z},#{THROW_RATIO.round(3)},x #{HARD_CUT_X}-#{WALL_W},Hard cut no blend
    CSV

    puts "FACADE_MZ20K_BUILD_OK=#{OUTPUT_SKP}"
    true
  rescue StandardError => e
    model.abort_operation if model
    File.write(File.join(OUTPUT_DIR,'BUILD_ERROR.txt'),"#{e.class}: #{e.message}\n#{e.backtrace.join("\n")}") rescue nil
    puts "FACADE_MZ20K_BUILD_ERROR=#{e.class}:#{e.message}"
    false
  end

  build
end
